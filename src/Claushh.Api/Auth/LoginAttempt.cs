// One login attempt, for the per-IP limit and the history in the security window (docs/ARCHITECTURE.md,
// "Backend", "Login protection"). No user name: it is unvalidated input and sometimes a mistyped password.
namespace Claushh.Api.Auth;

public sealed class LoginAttempt
{
    public long Id { get; set; }
    public DateTimeOffset At { get; set; }
    public required string Ip { get; set; }
    // What the per-IP limit counts by: Ip itself, or its /64 for IPv6 (LoginGuard.ClientIp).
    public required string LimitKey { get; set; }
    public required string Device { get; set; }
    public bool Success { get; set; }
    // LoginMethods.Password or LoginMethods.Passkey; a failed re-authentication is a password attempt.
    public required string Method { get; set; }
}

public static class LoginMethods
{
    public const string Password = "password";
    public const string Passkey = "passkey";
}
