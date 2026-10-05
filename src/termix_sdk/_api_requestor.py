# Adapted from stripe-python (stripe/_api_requestor.py), MIT License,
# Copyright (c) 2010-2018 Stripe. See NOTICE for the full license text.
"""Builds and sends one API call: resolves which service's base URL to hit,
attaches auth, serializes the body, and turns a non-2xx response into the
right `TermixError` subclass.

Diverges from stripe's requestor in the ways docs/sdk-plan.md calls out:
no form-encoding (`_encode.py` doesn't exist here — bodies are plain JSON
or httpx-native multipart), no idempotency keys, no API-version header,
and URL resolution goes through `ClientOptions.base_url_for(service)`
instead of a single fixed API base.
"""

from __future__ import annotations

import json as _json
from collections.abc import AsyncIterator, Iterator, Mapping
from typing import Any
from urllib.parse import urljoin

from . import _util
from ._client_options import ClientOptions
from ._compat_routes import rewrite_path
from ._error import APIConnectionError, error_for_status
from ._http_client import (
    RETRIABLE_STATUS_CODES,
    AsyncHTTPClient,
    AsyncHTTPXClient,
    HTTPClient,
    HTTPXClient,
    ShouldRetry,
)
from ._request_options import RequestOptions, request_headers
from ._response import SSEEvent, TermixResponse, TermixStreamResponse
from ._sse import aiter_sse_events, iter_sse_events

USER_AGENT = "termix-sdk-python"


def _should_retry(method: str) -> ShouldRetry:
    """GET/HEAD are safe to retry on a retryable status too; other verbs
    only retry on a connection failure (the request never reached the
    server, so nothing has happened yet) — retrying a POST after a
    completed-but-slow-to-answer request could double an action like
    `POST /fleets/{id}/execute`.
    """
    method = method.upper()

    def predicate(_num_retries: int, status: int | None, _headers: Mapping[str, str]) -> bool:
        if status is None:
            return True  # connection failure: always safe to retry
        if method in ("GET", "HEAD"):
            return status in RETRIABLE_STATUS_CODES
        return False

    return predicate


class APIRequestor:
    def __init__(self, options: ClientOptions, http_client: HTTPClient | None = None) -> None:
        self._options = options
        self._http_client = http_client or HTTPXClient(
            verify=options.verify, timeout=options.timeout
        )

    def close(self) -> None:
        self._http_client.close()

    def _url_for(self, service: str | None, path: str) -> str:
        base = self._options.base_url_for(service)
        return urljoin(base + "/", path.lstrip("/"))

    def _headers(self, options: RequestOptions | None) -> dict:
        headers = {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        bearer_token = self._options.bearer_token
        if bearer_token is not None:
            headers["Authorization"] = f"Bearer {bearer_token}"
        headers.update(self._options.default_headers)
        headers.update(request_headers(options))
        return headers

    def request(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        files: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> TermixResponse | None:
        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        timeout = (options or {}).get("timeout", self._options.timeout)
        max_retries = (options or {}).get("max_network_retries", self._options.max_network_retries)

        _util.log_debug("Sending request", method=method, url=url)
        content, status_code, resp_headers = self._http_client.request_with_retries(
            method,
            url,
            headers=headers,
            params=query,
            json=json_body if files is None else None,
            data=json_body if files is not None else None,
            files=files,
            timeout=timeout,
            max_retries=max_retries,
            should_retry=_should_retry(method),
        )
        return self._interpret_response(status_code, content, resp_headers)

    def request_stream(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        options: RequestOptions | None = None,
    ) -> TermixStreamResponse:
        """For `application/octet-stream` responses (file downloads). Never
        retried — see `HTTPClient.request_stream`.
        """
        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        timeout = (options or {}).get("timeout", self._options.timeout)

        iterator, status_code, resp_headers = self._http_client.request_stream(
            method, url, headers=headers, params=query, json=json_body, timeout=timeout
        )
        if status_code >= 400:
            body = b"".join(iterator)
            self._interpret_response(status_code, body, resp_headers)  # raises
        return TermixStreamResponse(iterator, status_code, resp_headers)

    def request_sse(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        options: RequestOptions | None = None,
    ) -> Iterator[SSEEvent]:
        """For the 3 `text/event-stream` endpoints (docs/sdk-plan.md
        section 6, item 2 / `_sse.py`). Never retried, same as
        `request_stream` — a partially-streamed connection can't be
        safely replayed.
        """
        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        headers["Accept"] = "text/event-stream"
        timeout = (options or {}).get("timeout", self._options.timeout)

        iterator, status_code, resp_headers = self._http_client.request_stream(
            method, url, headers=headers, params=query, json=json_body, timeout=timeout
        )
        if status_code >= 400:
            body = b"".join(iterator)
            self._interpret_response(status_code, body, resp_headers)  # raises
        return iter_sse_events(iterator)

    def _interpret_response(
        self,
        status_code: int,
        content: bytes,
        headers: Mapping[str, str],
    ) -> TermixResponse | None:
        if status_code == 204 or not content:
            if status_code >= 400:
                self._raise_for_status(status_code, {}, content, headers)
            return None

        content_type = headers.get("content-type", "")
        if "application/json" not in content_type:
            # A handful of endpoints (e.g. RSS/health text, some error
            # fallbacks) answer without a JSON content-type even on success.
            # We still try to parse — Termix's own error middleware always
            # sends JSON regardless of what a route declares — and fall
            # back to the raw text if that fails.
            try:
                data = _json.loads(content)
            except ValueError:
                if status_code >= 400:
                    self._raise_for_status(status_code, {}, content, headers)
                return TermixResponse(content, None, status_code, headers)
        else:
            try:
                data = _json.loads(content)
            except ValueError as exc:
                raise APIConnectionError(
                    f"Termix returned a response with an "
                    f"application/json content-type that wasn't valid "
                    f"JSON: {exc}"
                ) from exc

        if status_code >= 400:
            body = data if isinstance(data, dict) else {}
            self._raise_for_status(status_code, body, content, headers)

        return TermixResponse(content, data, status_code, headers)

    def _raise_for_status(
        self,
        status_code: int,
        body: dict,
        raw_content: bytes,
        headers: Mapping[str, str],
    ) -> None:
        message = body.get("error") if isinstance(body.get("error"), str) else None
        if message is None:
            message = f"Termix API returned status {status_code} with no error message"
        code = body.get("code") if isinstance(body.get("code"), str) else None
        raise error_for_status(
            status_code,
            message=message,
            code=code,
            body=body,
            http_body=raw_content.decode("utf-8", errors="replace") if raw_content else None,
            headers=dict(headers),
        )


class AsyncAPIRequestor:
    """Async mirror of `APIRequestor`, used by `AsyncTermixClient`. Response
    interpretation and error-raising are pure functions of
    (status, content, headers) with nothing async about them, so they're
    delegated to a plain `APIRequestor` instance instead of duplicating
    that logic.
    """

    def __init__(self, options: ClientOptions, http_client: AsyncHTTPClient | None = None) -> None:
        self._http_client = http_client or AsyncHTTPXClient(
            verify=options.verify, timeout=options.timeout
        )
        self._sync_delegate = APIRequestor(options, http_client=_NullHTTPClient())

    @property
    def _options(self) -> ClientOptions:
        # `self._sync_delegate._options` is the single source of truth —
        # `_auth.py` swaps in a freshly-authenticated ClientOptions after
        # login/TOTP by assigning `requestor._options = ...`, and that has
        # to reach `_headers()`/`_url_for()` below, which read through the
        # delegate. A plain instance attribute here would silently keep
        # pointing at the pre-login (anonymous) options instead.
        return self._sync_delegate._options

    @_options.setter
    def _options(self, value: ClientOptions) -> None:
        self._sync_delegate._options = value

    async def close(self) -> None:
        await self._http_client.close()

    def _url_for(self, service: str | None, path: str) -> str:
        return self._sync_delegate._url_for(service, path)

    def _headers(self, options: RequestOptions | None) -> dict:
        return self._sync_delegate._headers(options)

    async def request(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        files: Mapping[str, Any] | None = None,
        options: RequestOptions | None = None,
    ) -> TermixResponse | None:
        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        timeout = (options or {}).get("timeout", self._options.timeout)
        max_retries = (options or {}).get("max_network_retries", self._options.max_network_retries)

        _util.log_debug("Sending request", method=method, url=url)
        content, status_code, resp_headers = await self._http_client.request_with_retries(
            method,
            url,
            headers=headers,
            params=query,
            json=json_body if files is None else None,
            data=json_body if files is not None else None,
            files=files,
            timeout=timeout,
            max_retries=max_retries,
            should_retry=_should_retry(method),
        )
        return self._sync_delegate._interpret_response(status_code, content, resp_headers)

    async def request_stream(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        options: RequestOptions | None = None,
    ):
        from ._response import AsyncTermixStreamResponse

        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        timeout = (options or {}).get("timeout", self._options.timeout)

        aiterator, status_code, resp_headers = await self._http_client.request_stream(
            method, url, headers=headers, params=query, json=json_body, timeout=timeout
        )
        if status_code >= 400:
            chunks = [chunk async for chunk in aiterator]
            body = b"".join(chunks)
            self._sync_delegate._interpret_response(status_code, body, resp_headers)  # raises
        return AsyncTermixStreamResponse(aiterator, status_code, resp_headers)

    async def request_sse(
        self,
        method: str,
        path: str,
        *,
        service: str | None = None,
        query: Mapping[str, Any] | None = None,
        json_body: Any | None = None,
        options: RequestOptions | None = None,
    ) -> AsyncIterator[SSEEvent]:
        """Async mirror of `APIRequestor.request_sse()` — see its docstring."""
        path = rewrite_path(method, path)
        url = self._url_for(service, path)
        headers = self._headers(options)
        headers["Accept"] = "text/event-stream"
        timeout = (options or {}).get("timeout", self._options.timeout)

        aiterator, status_code, resp_headers = await self._http_client.request_stream(
            method, url, headers=headers, params=query, json=json_body, timeout=timeout
        )
        if status_code >= 400:
            chunks = [chunk async for chunk in aiterator]
            body = b"".join(chunks)
            self._sync_delegate._interpret_response(status_code, body, resp_headers)  # raises
        return aiter_sse_events(aiterator)


class _NullHTTPClient(HTTPClient):
    """Never used to actually send anything — `AsyncAPIRequestor` only
    borrows `APIRequestor`'s pure response-parsing methods, never its
    `request`/`request_with_retries`. Keeping `APIRequestor.__init__` from
    constructing a real (sync) `HTTPXClient` here avoids opening a second,
    unused connection pool per `AsyncTermixClient`.
    """

    def __init__(self) -> None:  # no super().__init__: nothing needs verify/timeout
        pass
