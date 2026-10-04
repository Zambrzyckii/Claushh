// A clean environment for every process the API starts (docs/ARCHITECTURE.md, "Backend" → "Workspaces and git"): an
// allowlist, not a denylist, because a denylist misses whatever the API's own process picks up next (a secret from a
// systemd unit, a variable a future dependency reads). `GitRunner` is the first caller; `TmuxServer` (the terminal)
// and `ClaudeCli` (the console) reuse it with their own overrides.
using System.Diagnostics;

namespace Claushh.Api.Processes;

public static class ChildEnvironment
{
    // Kept from the API's own environment when set, before `overrides` is applied.
    private static readonly string[] Passthrough = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TZ"];

    // Clears `start.Environment` (ProcessStartInfo otherwise inherits the API's whole environment) and rebuilds it
    // from the allowlist above, every `LC_*` variable, `LANG=C.UTF-8` when neither `LANG`, `LC_ALL` nor `LC_CTYPE` is
    // set (so a child process gets a locale even on a server without one), then `overrides` (applied last, so a
    // caller's own values win).
    public static void Apply(ProcessStartInfo start, IReadOnlyDictionary<string, string>? overrides = null)
    {
        start.Environment.Clear();
        foreach (var name in Passthrough)
        {
            if (Environment.GetEnvironmentVariable(name) is { } value)
            {
                start.Environment[name] = value;
            }
        }
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if ((string)entry.Key is var name && name.StartsWith("LC_", StringComparison.Ordinal) && entry.Value is string value)
            {
                start.Environment[name] = value;
            }
        }
        if (!start.Environment.ContainsKey("LANG") && !start.Environment.ContainsKey("LC_ALL") && !start.Environment.ContainsKey("LC_CTYPE"))
        {
            start.Environment["LANG"] = "C.UTF-8";
        }
        if (overrides is null)
        {
            return;
        }
        foreach (var (name, value) in overrides)
        {
            start.Environment[name] = value;
        }
    }
}
