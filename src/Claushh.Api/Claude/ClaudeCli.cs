// The claude CLI as the console runs it (docs/ARCHITECTURE.md, "Backend" → "Console"; decisions: docs/PLAN.md,
// "Backend decisions (stage 3)"): its config directory (prepared at start), the version check before the first claude
// process and the allowlisted environment of every claude process. Without a usable CLI the console answers "Konsola
// niedostępna" and its conversations can still be read.
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Claushh.Api.Files;
using Claushh.Api.Processes;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Claude;

public sealed partial class ClaudeCli(IOptions<ConsoleOptions> options, ProjectPaths paths, ILogger<ClaudeCli> log)
{
    public const string Unavailable = "Konsola niedostępna";
    public static readonly Version Minimum = new(2, 1, 285);

    private static readonly TimeSpan VersionTimeout = TimeSpan.FromSeconds(10);
    // Passed through when the API has them, as git gets them, so that git push in a step reaches the credential helper.
    private static readonly string[] Passthrough = ["XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

    // Any permission for the group or for others.
    private const UnixFileMode GroupOrOther = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
        | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;

    // One version check at a time (EnsureAvailableAsync).
    private readonly SemaphoreSlim _check = new(1, 1);

    public bool Available { get; private set; }
    public string ConfigDirectory { get; private set; } = "";

    // At start (Conversations.StartAsync): the config directory, created with mode 0700. No claude process runs while
    // the host starts; the version check waits for the first claude process (EnsureAvailableAsync).
    public bool PrepareDirectory()
    {
        var directory = options.Value.ConfigDirectory ?? DefaultConfigDirectory();
        if (directory is null || !Path.IsPathFullyQualified(directory))
        {
            log.LogError("Console:ConfigDirectory is not an absolute path and neither XDG_STATE_HOME nor HOME is set: the console is unavailable.");
            return false;
        }
        if (options.Value.ApiKeyFile is { } keyFile && KeyFileProblem(keyFile) is { } problem)
        {
            log.LogError("Console:ApiKeyFile {Problem}: the console is unavailable.", problem);
            return false;
        }
        try
        {
            Directory.CreateDirectory(directory);
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            ConfigDirectory = directory;
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log.LogError(e, "The console is unavailable: preparing its config directory failed");
            return false;
        }
    }

    // Why Console:ApiKeyFile cannot be used, or null: it must be the absolute path of an existing file that lies outside
    // the projects directory as written and with symlinks resolved (its directory and the file itself), and whose mode
    // has no group or other bit.
    private string? KeyFileProblem(string keyFile)
    {
        if (!Path.IsPathFullyQualified(keyFile) || !File.Exists(keyFile) || Libc.RealPath(keyFile, out _) is not { } real
            || Libc.RealPath(Path.GetDirectoryName(Path.GetFullPath(keyFile))!, out _) is not { } directory)
        {
            return "is not the absolute path of an existing file";
        }
        var inside = paths.Root + "/";
        if (Path.GetFullPath(keyFile).StartsWith(inside, StringComparison.Ordinal) || directory == paths.Root
            || directory.StartsWith(inside, StringComparison.Ordinal) || real.StartsWith(inside, StringComparison.Ordinal))
        {
            return "lies in the projects directory";
        }
        return (File.GetUnixFileMode(real) & GroupOrOther) != 0 ? "has permissions for the group or others (use mode 0600)" : null;
    }

    // The config directory, then `claude --version` within 10 s, at least Minimum.
    public async Task PrepareAsync(CancellationToken ct)
    {
        Available = false;
        if (!PrepareDirectory())
        {
            return;
        }
        var version = await VersionAsync(ct);
        if (version is null || version < Minimum)
        {
            log.LogError("The console needs the claude CLI {Minimum} or later at Console:ClaudePath; found {Version}.",
                Minimum, version?.ToString() ?? "none");
            return;
        }
        log.LogInformation("The console runs claude {Version}", version);
        Available = true;
    }

    // Before a claude process starts: PrepareAsync, unless a check has passed. A failed check is repeated by the next
    // prompt, so a CLI installed while the API runs needs no restart.
    public async Task<bool> EnsureAvailableAsync(CancellationToken ct)
    {
        await _check.WaitAsync(ct);
        try
        {
            if (!Available)
            {
                await PrepareAsync(ct);
            }
            return Available;
        }
        finally
        {
            _check.Release();
        }
    }

    // claude in `directory` with `arguments` (no shell) and the allowlisted environment (ChildEnvironment), then
    // XDG_CONFIG_HOME, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS when the API has them, CLAUDE_CONFIG_DIR,
    // DISABLE_UPDATES=1, DISABLE_AUTOUPDATER=1 and TERM=dumb, then Console:Environment. None of the API's own variables
    // (the connection string, ANTHROPIC_API_KEY, CLAUDECODE*) reach the CLI.
    public ProcessStartInfo StartInfo(string directory, IEnumerable<string> arguments)
    {
        var start = new ProcessStartInfo(options.Value.ClaudePath)
        {
            WorkingDirectory = directory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }
        var overrides = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in Passthrough)
        {
            if (Environment.GetEnvironmentVariable(name) is { } value)
            {
                overrides[name] = value;
            }
        }
        overrides["CLAUDE_CONFIG_DIR"] = ConfigDirectory;
        overrides["DISABLE_UPDATES"] = "1";
        overrides["DISABLE_AUTOUPDATER"] = "1";
        overrides["TERM"] = "dumb";
        foreach (var (name, value) in options.Value.Environment)
        {
            overrides[name] = value;
        }
        ChildEnvironment.Apply(start, overrides);
        return start;
    }

    // Every tool the model may use; the others (AskUserQuestion, EnterPlanMode, worktrees, scheduling, notifications,
    // Skill, …) are off.
    public const string Tools = "Bash,Read,Edit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch,Task,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,ToolSearch,ExitPlanMode";

    // A conversation's command line: stream-json both ways, questions over stdio, the hardening flags, the options of the
    // prompt that starts it, and the conversation's id as a new session or one to resume.
    public IReadOnlyList<string> Arguments(Guid conversation, bool resume, PromptOptions prompt, IReadOnlyList<string> rules) =>
    [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-prompt-tool", "stdio", "--restricted", "--tools", Tools, "--strict-mcp-config",
        "--disable-slash-commands", "--no-chrome", "--settings", Settings(rules), "--model", prompt.Model, "--effort",
        prompt.Effort, "--permission-mode", prompt.Mode, resume ? "--resume" : "--session-id", conversation.ToString("D"),
    ];

    // No hooks, no read outside the working directory without a question, the project's "always" rules, transcripts kept
    // 90 days, and the API key file through apiKeyHelper when one is configured.
    public string Settings(IReadOnlyList<string> rules)
    {
        var allow = new JsonArray();
        foreach (var rule in rules)
        {
            allow.Add(JsonValue.Create(rule));
        }
        var settings = new JsonObject
        {
            ["disableAllHooks"] = true,
            ["permissions"] = new JsonObject { ["blockReadsOutsideWorkingDirectories"] = true, ["allow"] = allow },
            ["cleanupPeriodDays"] = 90,
        };
        if (options.Value.ApiKeyFile is { } keyFile)
        {
            settings["apiKeyHelper"] = $"cat -- '{keyFile.Replace("'", "'\\''", StringComparison.Ordinal)}'";
        }
        return settings.ToJsonString();
    }

    private async Task<Version?> VersionAsync(CancellationToken ct)
    {
        try
        {
            using var claude = Process.Start(StartInfo(ConfigDirectory, ["--version"]))!;
            claude.StandardInput.Close();
            var output = claude.StandardOutput.ReadToEndAsync(ct);
            var errors = claude.StandardError.ReadToEndAsync(ct);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(VersionTimeout);
            try
            {
                await claude.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                try
                {
                    claude.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                    // It exited in the meantime.
                }
                return null;
            }
            await errors;
            var match = VersionPattern().Match(await output);
            return claude.ExitCode == 0 && match.Success
                ? new Version(Number(match, 1), Number(match, 2), Number(match, 3))
                : null;
        }
        catch (Win32Exception)
        {
            // No such file, or not executable.
            return null;
        }
    }

    private static string? DefaultConfigDirectory() =>
        Environment.GetEnvironmentVariable("XDG_STATE_HOME") is { Length: > 0 } state ? Path.Join(state, "claushh", "claude")
        : Environment.GetEnvironmentVariable("HOME") is { Length: > 0 } home ? Path.Join(home, ".local", "state", "claushh", "claude")
        : null;

    private static int Number(Match match, int group) => int.Parse(match.Groups[group].Value, CultureInfo.InvariantCulture);

    // "2.1.289 (Claude Code)".
    [GeneratedRegex(@"^(\d+)\.(\d+)\.(\d+)")]
    private static partial Regex VersionPattern();
}
