'use strict';

class SecondaryDetailsError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SecondaryDetailsError';
    this.code = code || 'secondary_details_error';
    if (details.status != null) this.status = details.status;
    if (details.retryAt != null) this.retryAt = details.retryAt;
    if (details.host != null) this.host = details.host;
    if (details.url != null) this.url = details.url;
    if (details.body != null) this.body = details.body;
    if (details.contentType != null) this.contentType = details.contentType;
    if (details.bodyBytes != null) this.bodyBytes = details.bodyBytes;
    if (details.reason != null) this.reason = details.reason;
    if (details.breakerCode != null) this.breakerCode = details.breakerCode;
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
