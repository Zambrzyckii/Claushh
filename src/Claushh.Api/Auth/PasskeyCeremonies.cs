// The passkey ceremonies in progress (docs/ARCHITECTURE.md, "Backend" → "Passkeys"), in this process only: login
// challenges, a registration's state per session and the sessions that re-authenticated. Every entry lasts 5 minutes by
// TimeProvider, and Take removes a state before returning it, so each is used once, also when the ceremony then fails.
// At most 3 pending login challenges per address (the per-IP limit's key) and 10,000 in all, and 20 sessions in each
// of the other two; beyond that the oldest entry goes.
using System.Buffers.Text;
using System.Security.Cryptography;

namespace Claushh.Api.Auth;

public sealed class PasskeyCeremonies(TimeProvider clock)
{
    // How long a ceremony may take (the authenticator's timeout) and how long a re-authentication lasts.
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private const int ChallengesPerAddress = 3;
    private const int MaxChallenges = 10_000;
    private const int MaxSessions = 20;

    // All three change under lock (_registrations). Order is the place in the order of making, so "the oldest" never
    // depends on two entries having the same time.
    private readonly Dictionary<string, Entry> _challenges = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, Entry> _registrations = new();
    private readonly Dictionary<Guid, Entry> _fresh = new();
    private long _order;

    // Keeps a login's state; returns the random id for the challenge cookie.
    public string AddLoginChallenge(string limitKey, string state)
    {
        var id = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        lock (_registrations)
        {
            Prune(_challenges);
            var ofAddress = _challenges.Where(c => c.Value.Group == limitKey).ToList();
            if (ofAddress.Count >= ChallengesPerAddress)
            {
                _challenges.Remove(ofAddress.MinBy(c => c.Value.Order).Key);
            }
            if (_challenges.Count >= MaxChallenges)
            {
                _challenges.Remove(_challenges.MinBy(c => c.Value.Order).Key);
            }
            _challenges[id] = new Entry(limitKey, state, clock.GetUtcNow(), ++_order);
        }
        return id;
    }

    public string? TakeLoginChallenge(string? id)
    {
        if (id is null)
        {
            return null;
        }
        lock (_registrations)
        {
            Prune(_challenges);
            return _challenges.Remove(id, out var entry) ? entry.State : null;
        }
    }

    // A newer creation-options of the session replaces its state.
    public void SetRegistration(Guid sessionId, string state)
    {
        lock (_registrations)
        {
            Put(_registrations, sessionId, state);
        }
    }

    public string? TakeRegistration(Guid sessionId)
    {
        lock (_registrations)
        {
            Prune(_registrations);
            return _registrations.Remove(sessionId, out var entry) ? entry.State : null;
        }
    }

    // After a re-authentication: creation-options and removing a passkey work for 5 minutes; using them does not end it.
    public void MarkFresh(Guid sessionId)
    {
        lock (_registrations)
        {
            Put(_fresh, sessionId, null);
        }
    }

    public bool IsFresh(Guid sessionId)
    {
        lock (_registrations)
        {
            Prune(_fresh);
            return _fresh.ContainsKey(sessionId);
        }
    }

    // ApiFactory.ResetAsync: every test starts without ceremonies.
    public void Clear()
    {
        lock (_registrations)
        {
            _challenges.Clear();
            _registrations.Clear();
            _fresh.Clear();
        }
    }

    private void Put(Dictionary<Guid, Entry> entries, Guid sessionId, string? state)
    {
        Prune(entries);
        entries.Remove(sessionId);
        if (entries.Count >= MaxSessions)
        {
            entries.Remove(entries.MinBy(e => e.Value.Order).Key);
        }
        entries[sessionId] = new Entry(null, state, clock.GetUtcNow(), ++_order);
    }

    // Expired entries go on every call.
    private void Prune<TKey>(Dictionary<TKey, Entry> entries) where TKey : notnull
    {
        var now = clock.GetUtcNow();
        foreach (var key in entries.Where(e => e.Value.Created + Lifetime <= now).Select(e => e.Key).ToList())
        {
            entries.Remove(key);
        }
    }

    // Group: the per-IP limit's key of a login challenge; null for the other two.
    private sealed record Entry(string? Group, string? State, DateTimeOffset Created, long Order);
}
