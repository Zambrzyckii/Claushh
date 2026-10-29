// The account's terminals in creation order (docs/ARCHITECTURE.md, "Backend" → "Terminal"; decisions: docs/PLAN.md,
// "Backend decisions (stage 4)"). A singleton, because a hub instance lives for one call. Also the hosted service that
// prepares the tmux server at start (never for create-user, which exits before the host runs) and ends it on a stop.
using Claushh.Api.Files;
using Claushh.Api.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace Claushh.Api.Terminal;

public sealed class Terminals(TmuxServer tmux, ProjectPaths paths, IHubContext<TerminalHub> hub, ILogger<Terminals> log)
    : IHostedService
{
    public const int Limit = 20;

    private readonly List<TerminalSession> _terminals = [];
    // Guarded by the list lock: set at the start of StopAsync, so an OpenAsync racing it never starts a terminal
    // after CloseAllAsync's snapshot, which would create a session nobody closes (kill-server already ran by then).
    private bool _stopped;

    public Task StartAsync(CancellationToken cancellationToken) => tmux.PrepareAsync(cancellationToken);

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        lock (_terminals)
        {
            _stopped = true;
        }
        await CloseAllAsync();
        await tmux.KillServerAsync();
    }

    // Empty without tmux: there is nothing to list, and opening says why.
    public IReadOnlyList<TerminalInfo> List()
    {
        lock (_terminals)
        {
            return [.. _terminals.Select(terminal => terminal.Info)];
        }
    }

    public async Task<TerminalInfo> OpenAsync(string? projectPath, int cols, int rows)
    {
        EnsureAvailable();
        if (projectPath is null || paths.Resolve(projectPath) is not { Kind: PathKind.Directory } directory)
        {
            throw new HubException("Invalid path");
        }
        TerminalSession terminal;
        lock (_terminals)
        {
            if (_stopped)
            {
                throw new HubException(TmuxServer.Unavailable);
            }
            if (_terminals.Count >= Limit)
            {
                throw new HubException("Too many terminals");
            }
            // A new id on every start of the API: a view that kept an old id's lastSeq would drop all new output.
            terminal = new TerminalSession(Guid.NewGuid().ToString("N"), Title(projectPath), projectPath, tmux,
                BroadcastAsync, ExitedAsync, log);
            _terminals.Add(terminal);
        }
        try
        {
            await terminal.StartAsync(directory.FullPath, TerminalSession.Cols(cols), TerminalSession.Rows(rows));
            return terminal.Info;
        }
        catch (Exception e)
        {
            lock (_terminals)
            {
                _terminals.Remove(terminal);
            }
            await terminal.CloseAsync();
            if (e is HubException)
            {
                throw;
            }
            log.LogError(e, "Starting a terminal failed");
            throw new HubException(TmuxServer.Unavailable);
        }
    }

    public TerminalSession Find(string? id)
    {
        EnsureAvailable();
        return TryFind(id) ?? throw new HubException("Unknown terminal");
    }

    public TerminalSession? TryFind(string? id)
    {
        lock (_terminals)
        {
            return _terminals.Find(terminal => terminal.Id == id);
        }
    }

    // An unknown id is not an error: another tab may have closed the terminal already.
    public async Task CloseAsync(string? id)
    {
        EnsureAvailable();
        TerminalSession? terminal;
        lock (_terminals)
        {
            terminal = _terminals.Find(t => t.Id == id);
            if (terminal is not null)
            {
                _terminals.Remove(terminal);
            }
        }
        if (terminal is not null)
        {
            await terminal.CloseAsync();
        }
    }

    // When the API stops, and in the tests before every test. One terminal's close failing is logged and does not
    // stop the others, so StopAsync always reaches KillServerAsync.
    public async Task CloseAllAsync()
    {
        TerminalSession[] all;
        lock (_terminals)
        {
            all = [.. _terminals];
            _terminals.Clear();
        }
        foreach (var terminal in all)
        {
            try
            {
                await terminal.CloseAsync();
            }
            catch (Exception e)
            {
                log.LogWarning(e, "Closing terminal {Id} failed", terminal.Id);
            }
        }
    }

    // The last segment of the path, or "projects" for the projects directory, plus " (k)" with the smallest free k from
    // 2, so titles stay unique also after a close. Called under the list's lock.
    private string Title(string projectPath)
    {
        var name = projectPath.Length == 0 ? "projects" : projectPath[(projectPath.LastIndexOf('/') + 1)..];
        var taken = _terminals.Select(terminal => terminal.Title).ToHashSet(StringComparer.Ordinal);
        if (!taken.Contains(name))
        {
            return name;
        }
        var k = 2;
        while (taken.Contains($"{name} ({k})"))
        {
            k++;
        }
        return $"{name} ({k})";
    }

    private Task BroadcastAsync(TerminalOutput output) => hub.Clients.All.SendAsync("TerminalOutput", output);

    private async Task ExitedAsync(TerminalSession terminal)
    {
        lock (_terminals)
        {
            if (!_terminals.Contains(terminal))
            {
                // Closed: no event.
                return;
            }
        }
        await hub.Clients.All.SendAsync("TerminalExited", new TerminalExit(terminal.Id, null));
    }

    private void EnsureAvailable()
    {
        if (!tmux.Available)
        {
            throw new HubException(TmuxServer.Unavailable);
        }
    }
}
