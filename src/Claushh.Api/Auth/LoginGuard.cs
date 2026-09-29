// Login protection (docs/ARCHITECTURE.md, "Backend", "Login protection"; decisions: docs/PLAN.md, "Login and sessions"):
// the limit of failed attempts per IP and the login history. The only place with these rules; the login endpoint calls
// it. Time comes from TimeProvider, so tests move the clock instead of waiting.
using Claushh.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Auth;

public sealed class LoginGuard(ClaushhDbContext db, TimeProvider clock)
{
    private const int MaxFailuresPerIp = 10;
    private static readonly TimeSpan IpWindow = TimeSpan.FromMinutes(15);

    // One login at a time in this process: the checks and writes of parallel attempts never interleave.
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public async Task<IDisposable> EnterAsync(CancellationToken ct)
    {
        await Gate.WaitAsync(ct);
        return new GateLease();
    }

    // Whole seconds until a login may be tried again, or null when it may be tried now.
    public async Task<int?> RetryAfterAsync(string ip, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var windowStart = now - IpWindow;
        var failures = await db.LoginAttempts
            .Where(a => a.Ip == ip && !a.Success && a.At > windowStart)
            .OrderByDescending(a => a.At)
            .Take(MaxFailuresPerIp)
            .Select(a => a.At)
            .ToListAsync(ct);
        return failures.Count == MaxFailuresPerIp ? SecondsUntil(failures[^1] + IpWindow, now) : null;
    }

    public async Task RecordAsync(bool success, string ip, string userAgent, CancellationToken ct)
    {
        db.LoginAttempts.Add(new LoginAttempt
        {
            At = clock.GetUtcNow(),
            Ip = ip,
            Device = DeviceName.Stored(userAgent),
            Success = success,
        });
        await db.SaveChangesAsync(ct);
    }

    private static int SecondsUntil(DateTimeOffset end, DateTimeOffset now) =>
        Math.Max(1, (int)Math.Ceiling((end - now).TotalSeconds));

    private sealed class GateLease : IDisposable
    {
        public void Dispose() => Gate.Release();
    }
}
