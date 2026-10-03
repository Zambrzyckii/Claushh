// Terminal:SocketDirectory and Terminal:Environment (docs/ARCHITECTURE.md, "Backend", configuration).
namespace Claushh.Api.Terminal;

public sealed class TerminalOptions
{
    // The directory of the API's tmux socket and configuration; null: $XDG_RUNTIME_DIR/claushh.
    public string? SocketDirectory { get; set; }

    // Variables for tmux and the shell on top of the allowlisted environment (in the tests SHELL and HOME).
    public Dictionary<string, string> Environment { get; set; } = new(StringComparer.Ordinal);
}
