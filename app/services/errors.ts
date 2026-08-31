export class DomainError extends Error {
  public statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class EditSessionNotFound extends DomainError {
  constructor(message = "Order edit session was not found.") {
    super(message, 404);
  }
}

export class EditSessionExpired extends DomainError {
  constructor(message = "Order editing window has expired.") {
    super(message, 410); // HTTP 410 Gone
  }
}

export class EditSessionAlreadyCompleted extends DomainError {
  constructor(message = "This order edit has already been completed.") {
    super(message, 409);
  }
}

export class OrderNotEditable extends DomainError {
  constructor(message = "This order is no longer eligible for editing (it may be fulfilled or cancelled).") {
    super(message, 422);
  }
}

export class MerchantPermissionDenied extends DomainError {
  constructor(permission: string) {
    super(`This operation is not permitted by store policy: ${permission}`, 403);
  }
}

export class PaymentRequired extends DomainError {
  public additionalAmount: number;
  public currency: string;
  constructor(additionalAmount: number, currency: string) {
    super(`Additional payment of ${currency} ${additionalAmount.toFixed(2)} is required to complete this edit.`, 402);
    this.additionalAmount = additionalAmount;
    this.currency = currency;
  }
}

export class InvalidEditRequest extends DomainError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ProductUnavailable extends DomainError {
  constructor(message = "The selected product is unavailable.") {
    super(message, 422);
  }
}

export class VariantUnavailable extends DomainError {
  constructor(message = "The selected variant is out of stock or unavailable.") {
    super(message, 422);
  }
}

export class ShopNotFound extends DomainError {
  constructor(message = "Shop not found or not installed.") {
    super(message, 404);
  }
}
