"""Domain-specific exceptions raised by the crawler."""


class FacebookError(Exception):
    """Base error for Facebook crawler failures."""


class FacebookAuthRequiredError(FacebookError):
    """Raised when Facebook requires authentication for requested content."""


class FacebookParseError(FacebookError):
    """Raised when Facebook content cannot be parsed safely."""


class FacebookVideoMismatchError(FacebookError):
    """Raised when a response describes a different video than the one requested."""


class FacebookHTTPError(FacebookError):
    """Raised after an HTTP request cannot be completed successfully."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.url = url

