'use strict';

/**
 * Error type and the one masking helper of the secondary-library pipeline.
 *
 * `SecondaryDetailsError` is thrown by every layer (transport → normalize →
 * sources → job) and is what `secondary-details.js` reports to the owner: a
 * `code`, an optional HTTP `status`, `retryAt`/`host` diagnostics, the raw
 * CMS body for the debug dump (masked on write) and the `deferred` flag that
 * keeps a network/5xx answer from becoming a negative cache entry.
 *
 * `maskSecrets` is applied to every error text / dump body: a stray URL query
 * (`?token=…`) must never reach a log, a status file or a report.
 */

class SecondaryDetailsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryDetailsError';
    this.code = code || 'secondary_details_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
    // Diagnostics for the CMS debug dump (never a token; masked on write).
    if (details.url != null) this.url = details.url;
    if (details.body != null) this.body = details.body;
    if (details.contentType != null) this.contentType = details.contentType;
    if (details.bodyBytes != null) this.bodyBytes = details.bodyBytes;
    if (details.reason != null) this.reason = details.reason;
    if (details.breakerCode != null) this.breakerCode = details.breakerCode;
    // A deferred answer must never become a negative cache entry.
    this.deferred = details.deferred === true;
  }
}

function maskSecrets(value) {
  return String(value == null ? '' : value).replace(
    /([?&](?:access_token|refresh_token|client_secret|code|token)=)[^&\s"']+/gi,
    '$1***'
  );
}

module.exports = {
  SecondaryDetailsError,
  maskSecrets,
};
