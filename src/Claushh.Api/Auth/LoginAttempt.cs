// One login attempt, for the per-IP limit and the history in the "Bezpieczeństwo" window (docs/ARCHITECTURE.md,
// "Backend", "Login protection"). No user name: it is unvalidated input and sometimes a mistyped password.
namespace Claushh.Api.Auth;

public sealed class LoginAttempt
{
    public long Id { get; set; }
    public DateTimeOffset At { get; set; }
    public required string Ip { get; set; }
    public required string Device { get; set; }
    public bool Success { get; set; }
}
