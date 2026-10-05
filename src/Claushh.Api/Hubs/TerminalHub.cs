// /hubs/terminal (docs/ARCHITECTURE.md, "Terminal"): the methods check their arguments and leave the terminals to
// Terminals, a singleton, because a hub instance lives for one call. The connection rules are the shared ones of Hubs/.
using Claushh.Api.Terminal;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Hubs;

public sealed class TerminalHub(Terminals terminals) : Hub
{
    // The contract's limits: a view's random id, and the UTF-16 units of one Input batch (terminal-input.ts).
    public const int MaxClient = 64;
    public const int MaxBatch = 4096;

    public sealed record OpenRequest(string? ProjectPath, int Cols, int Rows);
    public sealed record AttachRequest(string? Id, int Cols, int Rows, string? Client);
    public sealed record InputRequest(string? Id, string? Client, long Seq, string? Data);
    public sealed record ResizeRequest(string? Id, int Cols, int Rows);
    public sealed record CloseRequest(string? Id);

    public IReadOnlyList<TerminalInfo> ListTerminals() => terminals.List();

    public Task<TerminalInfo> OpenTerminal(OpenRequest? request) =>
        terminals.OpenAsync(request?.ProjectPath, request?.Cols ?? 0, request?.Rows ?? 0);

    public Task<Attachment> Attach(AttachRequest? request) =>
        terminals.Find(request?.Id).AttachAsync(TerminalSession.Cols(request?.Cols ?? 0),
            TerminalSession.Rows(request?.Rows ?? 0),
            request?.Client is { Length: >= 1 and <= MaxClient } client ? client : null, Context.ConnectionId);

    // The result is the acknowledgement; an unknown or exited terminal is skipped without an error.
    public async Task Input(InputRequest? request)
    {
        if (request?.Client is not { Length: >= 1 and <= MaxClient } client || request.Seq < 1
            || request.Data is not { Length: <= MaxBatch } data)
        {
            throw new HubException("Nieprawidłowa paczka");
        }
        if (terminals.TryFind(request.Id) is { } terminal)
        {
            await terminal.InputAsync(client, request.Seq, data, Context.ConnectionId);
        }
    }

    // A send: an unknown terminal or a missing argument is ignored.
    public async Task Resize(ResizeRequest? request)
    {
        if (request is not null && terminals.TryFind(request.Id) is { } terminal)
        {
            await terminal.ResizeAsync(TerminalSession.Cols(request.Cols), TerminalSession.Rows(request.Rows));
        }
    }

    public Task CloseTerminal(CloseRequest? request) => terminals.CloseAsync(request?.Id);
}
