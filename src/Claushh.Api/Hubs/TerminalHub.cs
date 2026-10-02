// /hubs/terminal (docs/ARCHITECTURE.md, "Terminal"). The connection rules (Origin, session) are the shared ones of
// Hubs/; the terminals themselves come with Terminal/.
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class TerminalHub : Hub
{
    public object[] ListTerminals() => [];
}
