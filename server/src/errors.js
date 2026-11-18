export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class AuthnError extends HttpError {
  constructor(message = "Sign in to continue.") {
    super(401, message);
  }
}

export class AuthzError extends HttpError {
  constructor(message = "You don't have permission to do that.") {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found.") {
    super(404, message);
  }
}

export class ValidationError extends HttpError {
  constructor(message) {
    super(400, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message) {
    super(409, message);
  }
}
