// Controllable clock for session deadlines, login limits and TOTP codes (TotpVerifier reads TimeProvider too).
// Every reset starts it at the current real second.
namespace Claushh.Api.Tests;

public sealed class TestClock : TimeProvider
{
    private DateTimeOffset _now;

    public TestClock() => Reset();

    public override DateTimeOffset GetUtcNow() => _now;

    public void Advance(TimeSpan by) => _now += by;

    // Whole seconds: PostgreSQL stores microseconds, and the remaining seconds in responses must be exact.
    public void Reset() => _now = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
}
