// The passkey ceremonies in progress (docs/ARCHITECTURE.md, "Backend" → "Passkeys"), in this process only: a
// registration's state per session and the sessions that re-authenticated. Every entry lasts 5 minutes by TimeProvider,
// and Take removes a state before returning it, so each is used once, also when the ceremony then fails. At most 20
// sessions in each; beyond that the oldest entry goes.
namespace Claushh.Api.Auth;

public sealed class PasskeyCeremonies(TimeProvider clock)
{
    // How long a ceremony may take (the authenticator's timeout) and how long a re-authentication lasts.
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private const int MaxSessions = 20;

    // Both change under lock (_registrations). Order is the place in the order of making, so "the oldest" never depends
    // on two entries having the same time.
    private readonly Dictionary<Guid, Entry> _registrations = new();
    private readonly Dictionary<Guid, Entry> _fresh = new();
    private long _order;

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
        entries[sessionId] = new Entry(state, clock.GetUtcNow(), ++_order);
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

    private sealed record Entry(string? State, DateTimeOffset Created, long Order);
}
