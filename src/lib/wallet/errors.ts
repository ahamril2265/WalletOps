/**
 * Business errors. Every DomainError carries the HTTP status and the machine-readable code that the
 * API returns. Anything that is NOT a DomainError is treated as a bug and becomes a 500.
 */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "VALIDATION_ERROR", message, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super(404, "NOT_FOUND", `${what} ${id} not found`, { id });
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(accountId: string, availableMinor: number, requiredMinor: number) {
    super(422, "INSUFFICIENT_FUNDS", "Insufficient funds", { accountId, availableMinor, requiredMinor });
  }
}

export class DailyLimitExceededError extends DomainError {
  constructor(accountId: string, limitMinor: number, usedMinor: number, requestedMinor: number) {
    super(422, "DAILY_LIMIT_EXCEEDED", "Daily outgoing limit exceeded", {
      accountId,
      limitMinor,
      usedMinor,
      requestedMinor,
    });
  }
}

export class AccountFrozenError extends Error {
  readonly status = 422;
  readonly code = "ACCOUNT_FROZEN";
  readonly details: Record<string, unknown>;
  constructor(accountId: string) {
    super("Account is frozen");
    this.details = { accountId };
  }
}

export class RefundError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(422, code, message, details);
  }
}

export class ProviderUnavailableError extends DomainError {
  constructor(provider: string) {
    super(502, "PROVIDER_UNAVAILABLE", `Payment provider '${provider}' is unavailable`, { provider });
  }
}

export class FxRatesStaleError extends DomainError {
  constructor(currency: string, ageMinutes: number) {
    super(503, "FX_RATES_STALE", `FX rate for ${currency} is ${ageMinutes} minutes old`, { currency, ageMinutes });
  }
}
