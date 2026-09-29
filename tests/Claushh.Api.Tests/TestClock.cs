// Controllable clock for session deadlines. It starts at the current real second, so TOTP codes computed from the
// real time are valid right after ResetAsync; tests log in before moving the clock.
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
