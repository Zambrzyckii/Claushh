// Login protection (docs/ARCHITECTURE.md, "Backend", "Login protection"; decisions: docs/PLAN.md, "Login and sessions"):
// the client address, the limit of failed attempts per address, the account lockout after wrong codes and the login
// history. The only place with these rules; the login endpoint calls it. Time comes from TimeProvider, so tests move
// the clock instead of waiting.
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Claushh.Api.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Claushh.Api.Auth;

public sealed class LoginGuard(ClaushhDbContext db, UserManager<IdentityUser> users, TimeProvider clock, ILogger<LoginGuard> log)
{
    private const int MaxFailuresPerIp = 10;
    private static readonly TimeSpan IpWindow = TimeSpan.FromMinutes(15);
    private const int MaxCodeFailures = 5;
    private static readonly TimeSpan FirstLockout = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan MaxLockout = TimeSpan.FromHours(24);
    private const int HistoryLength = 20;
    // Locks in a row without a successful login, stored under TotpVerifier.LoginProvider next to TotpLastStep.
    private const string LockoutsToken = "LockoutsInARow";

    // One login at a time in this process: the checks and writes of parallel attempts never interleave. A login waits at
    // most 10 s for the one before it.
    private static readonly SemaphoreSlim Gate = new(1, 1);
    public static readonly TimeSpan GateWait = TimeSpan.FromSeconds(10);

    // The lease of the gate, or null when the login before it still runs after GateWait (the endpoint answers 429).
    public async Task<IDisposable?> EnterAsync(CancellationToken ct)
    {
        if (!await Gate.WaitAsync(GateWait, ct))
        {
            return null;
        }
        // What the request loaded before the gate (the user of its session cookie) may be stale by now: forget it, so the
        // checks read the rows as the previous login left them. Only Login calls this, and it has no unsaved changes here.
        db.ChangeTracker.Clear();
        return new GateLease();
    }

    // The client's address as the history, the session list and the logs show it, and the key the per-IP limit counts by:
    // an IPv4 address (also one mapped into IPv6) as itself, an IPv6 address by its /64, since one connection usually has
    // a whole /64 and can change the rest at will. "" for both when the server knows no address.
    public static (string Text, string LimitKey) ClientIp(IPAddress? address)
    {
        if (address is null)
        {
            return ("", "");
        }
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }
        var text = address.ToString();
        if (address.AddressFamily != AddressFamily.InterNetworkV6)
        {
            return (text, text);
        }
        var prefix = address.GetAddressBytes();
        Array.Clear(prefix, 8, 8);
        return (text, new IPAddress(prefix) + "/64");
    }

    // Whole seconds until a login may be tried again (the later end of both limits), or null when it may be tried now.
    public async Task<int?> RetryAfterAsync(string limitKey, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var windowStart = now - IpWindow;
        var failures = await db.LoginAttempts
            .Where(a => a.LimitKey == limitKey && !a.Success && a.At > windowStart)
            .OrderByDescending(a => a.At)
            .Take(MaxFailuresPerIp)
            .Select(a => a.At)
            .ToListAsync(ct);
        DateTimeOffset? ipLimitEnd = failures.Count == MaxFailuresPerIp ? failures[^1] + IpWindow : null;
        // One account: while it is locked every attempt is refused, whatever the name and password.
        var lockoutEnd = await db.Users.Where(u => u.LockoutEnd > now).MaxAsync(u => u.LockoutEnd, ct);
        var end = new[] { ipLimitEnd, lockoutEnd }.Max();
        return end is { } later ? SecondsUntil(later, now) : null;
    }

    public async Task RecordAsync(bool success, string ip, string limitKey, string userAgent, CancellationToken ct)
    {
        db.LoginAttempts.Add(new LoginAttempt
        {
            At = clock.GetUtcNow(),
            Ip = ip,
            LimitKey = limitKey,
            Device = DeviceName.Stored(userAgent),
            Success = success,
        });
        await db.SaveChangesAsync(ct);
    }

    // The history for the "Bezpieczeństwo" window: the last 20, newest first (Id breaks ties of the same time).
    public Task<List<LoginAttempt>> RecentAsync(CancellationToken ct) =>
        db.LoginAttempts
            .OrderByDescending(a => a.At)
            .ThenByDescending(a => a.Id)
            .Take(HistoryLength)
            .AsNoTracking()
            .ToListAsync(ct);

    public Task<int> DeleteAttemptsBeforeAsync(DateTimeOffset cutoff, CancellationToken ct) =>
        db.LoginAttempts.Where(a => a.At < cutoff).ExecuteDeleteAsync(ct);

    // A wrong or reused code after a correct password. The fifth locks the account and starts the count again; every
    // lock in a row without a successful login lasts twice as long as the one before, at most MaxLockout.
    // Identity's own lockout methods use the real clock and require LockoutEnabled, so the fields are set here.
    public async Task CodeFailedAsync(IdentityUser user)
    {
        user.AccessFailedCount++;
        if (user.AccessFailedCount >= MaxCodeFailures)
        {
            var lockouts = await LockoutsInARowAsync(user) + 1;
            var duration = LockoutDuration(lockouts);
            user.AccessFailedCount = 0;
            user.LockoutEnd = clock.GetUtcNow() + duration;
            ThrowIfFailed(await users.SetAuthenticationTokenAsync(user, TotpVerifier.LoginProvider, LockoutsToken,
                lockouts.ToString(CultureInfo.InvariantCulture)));
            log.LogWarning("Account locked for {Minutes} minutes after {Failures} wrong codes, lock {Lockouts} in a row",
                duration.TotalMinutes, MaxCodeFailures, lockouts);
        }
        await SaveAsync(user);
    }

    public async Task SucceededAsync(IdentityUser user)
    {
        if (await LockoutsInARowAsync(user) > 0)
        {
            ThrowIfFailed(await users.RemoveAuthenticationTokenAsync(user, TotpVerifier.LoginProvider, LockoutsToken));
        }
        if (user.AccessFailedCount > 0)
        {
            user.AccessFailedCount = 0;
            await SaveAsync(user);
        }
    }

    // `create-user --reset-totp` and `--reset-password`: shell access on the server proves more than a code.
    public async Task UnlockAsync(IdentityUser user)
    {
        ThrowIfFailed(await users.RemoveAuthenticationTokenAsync(user, TotpVerifier.LoginProvider, LockoutsToken));
        user.AccessFailedCount = 0;
        user.LockoutEnd = null;
        await SaveAsync(user);
    }

    private async Task<int> LockoutsInARowAsync(IdentityUser user) =>
        int.TryParse(await users.GetAuthenticationTokenAsync(user, TotpVerifier.LoginProvider, LockoutsToken),
            NumberStyles.None, CultureInfo.InvariantCulture, out var lockouts) ? lockouts : 0;

    // 15 minutes for the first lock in a row, twice as long for each further one, at most 24 hours.
    private static TimeSpan LockoutDuration(int lockouts)
    {
        // The cap on the exponent keeps TimeSpan from overflowing after many locks in a row; from the 8th lock on the
        // result is 24 hours anyway.
        var duration = FirstLockout * Math.Pow(2, Math.Min(lockouts - 1, 16));
        return duration < MaxLockout ? duration : MaxLockout;
    }

    private async Task SaveAsync(IdentityUser user) => ThrowIfFailed(await users.UpdateAsync(user));

    private static void ThrowIfFailed(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }

    private static int SecondsUntil(DateTimeOffset end, DateTimeOffset now) =>
        Math.Max(1, (int)Math.Ceiling((end - now).TotalSeconds));

    // Releases the gate once, also when it is disposed twice.
    private sealed class GateLease : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                Gate.Release();
            }
        }
    }
}
