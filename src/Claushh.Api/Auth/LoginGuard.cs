// Login protection (docs/ARCHITECTURE.md, "Backend", "Login protection"; decisions: docs/PLAN.md, "Login and sessions"):
// the limit of failed attempts per IP, the account lockout after wrong codes and the login history. The only place with
// these rules; the login endpoint calls it. Time comes from TimeProvider, so tests move the clock instead of waiting.
using Claushh.Api.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Auth;

public sealed class LoginGuard(ClaushhDbContext db, UserManager<IdentityUser> users, TimeProvider clock, ILogger<LoginGuard> log)
{
    private const int MaxFailuresPerIp = 10;
    private static readonly TimeSpan IpWindow = TimeSpan.FromMinutes(15);
    private const int MaxCodeFailures = 5;
    private static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

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
        if (failures.Count == MaxFailuresPerIp)
        {
            return SecondsUntil(failures[^1] + IpWindow, now);
        }
        // One account: while it is locked every attempt is refused, whatever the name and password, so the answer
        // reveals neither.
        var lockoutEnd = await db.Users.Where(u => u.LockoutEnd > now).MaxAsync(u => u.LockoutEnd, ct);
        return lockoutEnd is { } end ? SecondsUntil(end, now) : null;
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

    // The history for the "Bezpieczeństwo" window: the last 20, newest first (Id breaks ties of the same time).
    public Task<List<LoginAttempt>> RecentAsync(CancellationToken ct) =>
        db.LoginAttempts.OrderByDescending(a => a.At).ThenByDescending(a => a.Id).Take(20).AsNoTracking().ToListAsync(ct);

    // A wrong or reused code after a correct password. The fifth locks the account and starts the count again.
    // Identity's own lockout methods use the real clock and require LockoutEnabled, so the fields are set here.
    public async Task CodeFailedAsync(IdentityUser user)
    {
        user.AccessFailedCount++;
        if (user.AccessFailedCount >= MaxCodeFailures)
        {
            user.AccessFailedCount = 0;
            user.LockoutEnd = clock.GetUtcNow() + LockoutDuration;
            log.LogWarning("Account locked for {Minutes} minutes after {Failures} wrong codes",
                LockoutDuration.TotalMinutes, MaxCodeFailures);
        }
        await SaveAsync(user);
    }

    public async Task SucceededAsync(IdentityUser user)
    {
        if (user.AccessFailedCount > 0)
        {
            user.AccessFailedCount = 0;
            await SaveAsync(user);
        }
    }

    // `create-user --reset-totp`: shell access on the server proves more than a code.
    public async Task UnlockAsync(IdentityUser user)
    {
        user.AccessFailedCount = 0;
        user.LockoutEnd = null;
        await SaveAsync(user);
    }

    private async Task SaveAsync(IdentityUser user)
    {
        var result = await users.UpdateAsync(user);
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }

    private static int SecondsUntil(DateTimeOffset end, DateTimeOffset now) =>
        Math.Max(1, (int)Math.Ceiling((end - now).TotalSeconds));

    private sealed class GateLease : IDisposable
    {
        public void Dispose() => Gate.Release();
    }
}
