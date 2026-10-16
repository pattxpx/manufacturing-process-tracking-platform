class BusinessRuleError(Exception):
    """A business rule stopped the request. Turned into a JSON error by main.py."""

    def __init__(self, message: str, status_code: int = 409):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def not_found(what: str) -> BusinessRuleError:
    return BusinessRuleError(f"{what} not found", status_code=404)
