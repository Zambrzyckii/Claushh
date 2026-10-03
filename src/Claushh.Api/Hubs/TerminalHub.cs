// /hubs/terminal (docs/ARCHITECTURE.md, "Terminal"): the methods check their arguments and leave the terminals to
// Terminals, a singleton, because a hub instance lives for one call. The connection rules are the shared ones of Hubs/.
using Claushh.Api.Terminal;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class TerminalHub(Terminals terminals) : Hub
{
    public sealed record OpenRequest(string? ProjectPath, int Cols, int Rows);
    public sealed record CloseRequest(string? Id);

    public IReadOnlyList<TerminalInfo> ListTerminals() => terminals.List();

    public Task<TerminalInfo> OpenTerminal(OpenRequest request) =>
        terminals.OpenAsync(request.ProjectPath, request.Cols, request.Rows);

    public Task CloseTerminal(CloseRequest request) => terminals.CloseAsync(request.Id);
}
