// Console:ClaudePath, Console:ConfigDirectory, Console:ApiKeyFile and Console:Environment (docs/ARCHITECTURE.md,
// "Backend", configuration).
namespace Claushh.Api.Claude;

public sealed class ConsoleOptions
{
    // The claude CLI: a name on PATH or an absolute path (on the server the launcher of Anthropic's installer, set by
    // the unit).
    public string ClaudePath { get; set; } = "claude";

    // The CLI's own state and login (CLAUDE_CONFIG_DIR); null: $XDG_STATE_HOME/claushh/claude, else
    // ~/.local/state/claushh/claude.
    public string? ConfigDirectory { get; set; }

    // A file with an Anthropic API key, read through the CLI's apiKeyHelper; it must lie outside the projects
    // directory as written and with symlinks resolved, and its mode must have no group or other bit
    // (ClaudeCli.PrepareDirectory). null: the login in ConfigDirectory.
    public string? ApiKeyFile { get; set; }

    // Variables for the claude process on top of its allowlisted environment.
    public Dictionary<string, string> Environment { get; set; } = new(StringComparer.Ordinal);
}
