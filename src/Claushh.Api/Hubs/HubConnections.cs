// The open hub connections by session (docs/ARCHITECTURE.md, "Backend" → "Hubs"), so the connections of an ended
// session can be closed. Every hub registers here through HubSessionFilter.
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class HubConnections
{
    private readonly Dictionary<Guid, Dictionary<string, HubCallerContext>> _bySession = new();

    public void Add(Guid session, HubCallerContext connection)
    {
        lock (_bySession)
        {
            if (!_bySession.TryGetValue(session, out var connections))
            {
                _bySession[session] = connections = new(StringComparer.Ordinal);
            }
            connections[connection.ConnectionId] = connection;
        }
    }

    public void Remove(Guid session, HubCallerContext connection)
    {
        lock (_bySession)
        {
            if (_bySession.TryGetValue(session, out var connections) && connections.Remove(connection.ConnectionId)
                && connections.Count == 0)
            {
                _bySession.Remove(session);
            }
        }
    }

    public Guid[] Sessions()
    {
        lock (_bySession)
        {
            return [.. _bySession.Keys];
        }
    }

    // Closes every connection of these sessions; returns how many there were. A closed connection does not reconnect:
    // the client checks the session over HTTP instead.
    public int Abort(IEnumerable<Guid> sessions)
    {
        List<HubCallerContext> closing = [];
        lock (_bySession)
        {
            foreach (var session in sessions)
            {
                if (_bySession.TryGetValue(session, out var connections))
                {
                    closing.AddRange(connections.Values);
                }
            }
        }
        foreach (var connection in closing)
        {
            connection.Abort();
        }
        return closing.Count;
    }
}
