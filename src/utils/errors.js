'use strict';

class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR' });
    this.name = 'ValidationError';
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(resource) {
    super(`${resource} not found`, { status: 404, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, { status: 409, code: 'CONFLICT' });
    this.name = 'ConflictError';
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
};
