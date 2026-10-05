// The only place with session rules: a random secret with only its SHA-256 in the database, the idle and the absolute
// deadline (docs/ARCHITECTURE.md, "Backend"). Endpoints, the handler and the hubs call it.
using System.Buffers.Text;
using System.Security.Cryptography;
using Claushh.Api.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Auth;

public sealed class SessionService(ClaushhDbContext db, TimeProvider clock, IOptions<AuthSessionOptions> options)
{
    private const int SecretBytes = 32;

    public async Task<(Session Session, string Secret)> CreateAsync(IdentityUser user, string device, string ip, CancellationToken ct)
    {
        var secret = RandomNumberGenerator.GetBytes(SecretBytes);
        var now = clock.GetUtcNow();
        var absolute = now + options.Value.AbsoluteTimeout;
        var session = new Session
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            User = user,
            SecretHash = SHA256.HashData(secret),
            CreatedAt = now,
            LastActivityAt = now,
            IdleExpiresAt = Min(now + options.Value.IdleTimeout, absolute),
            AbsoluteExpiresAt = absolute,
            Device = DeviceName.Stored(device),
            Ip = ip,
        };
        db.Sessions.Add(session);
        await db.SaveChangesAsync(ct);
        return (session, Base64Url.EncodeToString(secret));
    }

    // Null for anything that is not the secret of an active session, including malformed cookie values.
    public async Task<Session?> FindActiveAsync(string secret, CancellationToken ct)
    {
        // IsValid, because TryDecodeFromChars returns false only for a too small buffer and throws on invalid characters.
        if (!Base64Url.IsValid(secret, out var length) || length != SecretBytes)
        {
            return null;
        }
        var hash = SHA256.HashData(Base64Url.DecodeFromChars(secret));
        return await Active().Include(s => s.User).SingleOrDefaultAsync(s => s.SecretHash == hash, ct);
    }

    // The only way a session gets longer: idle deadline from now, never past the absolute one.
    public async Task ExtendAsync(Session session, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        session.LastActivityAt = now;
        session.IdleExpiresAt = Min(now + options.Value.IdleTimeout, session.AbsoluteExpiresAt);
        await db.SaveChangesAsync(ct);
    }

    // Ends an active session of the user. False when there is none: unknown, already ended or expired.
    public async Task<bool> RevokeAsync(Guid id, string userId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var ended = await Active()
            .Where(s => s.Id == id && s.UserId == userId)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now), ct);
        return ended == 1;
    }

    public async Task RevokeAllAsync(string userId, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        await Active().Where(s => s.UserId == userId).ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now), ct);
    }

    // Revoking the others: every other active session of the user, in one UPDATE.
    public async Task RevokeOthersAsync(Session current, CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        await Active()
            .Where(s => s.UserId == current.UserId && s.Id != current.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now), ct);
    }

    public Task<List<Session>> ListActiveAsync(string userId, CancellationToken ct) =>
        Active().Where(s => s.UserId == userId).OrderByDescending(s => s.CreatedAt).AsNoTracking().ToListAsync(ct);

    // For the hubs (Hubs/HubSessionFilter): whether a session is still active. Like FindActiveAsync, it never extends it.
    public Task<bool> IsActiveAsync(Guid id, CancellationToken ct) => Active().AnyAsync(s => s.Id == id, ct);

    // For the hubs (Hubs/HubSessionSweep): which of these sessions are still active, in one query.
    public Task<List<Guid>> ActiveIdsAsync(Guid[] ids, CancellationToken ct) =>
        Active().Where(s => ids.Contains(s.Id)).Select(s => s.Id).ToListAsync(ct);

    // A session ended at RevokedAt, or else at IdleExpiresAt, which is never later than AbsoluteExpiresAt.
    public Task<int> DeleteEndedBeforeAsync(DateTimeOffset cutoff, CancellationToken ct) =>
        db.Sessions.Where(s => (s.RevokedAt ?? s.IdleExpiresAt) < cutoff).ExecuteDeleteAsync(ct);

    // Whole seconds until each deadline, as the frontend expects (relative, so a wrong device clock does not matter).
    public (int ExpiresIn, int AbsoluteExpiresIn) SecondsLeft(Session session)
    {
        var now = clock.GetUtcNow();
        return (Seconds(session.IdleExpiresAt - now), Seconds(session.AbsoluteExpiresAt - now));
    }

    private IQueryable<Session> Active()
    {
        var now = clock.GetUtcNow();
        return db.Sessions.Where(s => s.RevokedAt == null && s.IdleExpiresAt > now && s.AbsoluteExpiresAt > now);
    }

    private static DateTimeOffset Min(DateTimeOffset a, DateTimeOffset b) => a < b ? a : b;

    private static int Seconds(TimeSpan span) => Math.Max(0, (int)span.TotalSeconds);
}
