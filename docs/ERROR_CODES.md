# API Error Codes

Every error response across `/v1` routes in the GuildPass Access API follows a shared envelope structure to make client integration easier and more predictable.

## Error Envelope Shape

```json
{
  "error": "ERROR_CODE",
  "code": "ERROR_CODE",
  "message": "Human-readable description",
  "statusCode": 400,
  "details": {
    "optional": "additional context"
  }
}
```

- **`error`** / **`code`**: Machine-readable string identifying the error type. Both fields mirror each other for backward compatibility.
- **`message`**: A human-readable description of the error suitable for developer logs.
- **`statusCode`**: The HTTP status code (e.g., 400, 404).
- **`details`**: Optional object or string containing specific information about the error (e.g., validation failure details, rate limit reset times).

## Standard Error Codes

The following is a list of stable code values returned by the API:

| Code | HTTP Status | Description |
| :--- | :--- | :--- |
| `VALIDATION_ERROR` | 400 | The request payload, parameters, or headers are invalid or missing. |
| `UNAUTHORIZED` | 401 | Authentication is required and has failed or has not yet been provided. |
| `FORBIDDEN` | 403 | The authenticated client does not have permission to perform the action. |
| `NOT_FOUND` | 404 | The requested resource could not be found. |
| `CONFLICT` | 409 | The request could not be completed due to a conflict with the current state of the resource. |
| `EXPIRED` | 410 | The requested resource (e.g., a nonce or session) is no longer available because it has expired. |
| `RATE_LIMITED` | 429 | The client has sent too many requests in a given amount of time. `details.retryAfter` may indicate when to retry. |
| `INTERNAL_ERROR` | 500 | An unexpected internal server error occurred. |
| `SERVICE_UNAVAILABLE` | 503 | The server is currently unable to handle the request (e.g., due to temporary overloading or maintenance). |

Any custom error codes thrown by internal services (e.g. `CONSTITUTIONAL_VIOLATION`) will also be correctly enveloped using this same shape.
