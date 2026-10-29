// The API's own tmux server (docs/ARCHITECTURE.md, "Backend" → "Terminal"; decisions: docs/PLAN.md, "Backend
// decisions (stage 4)"): its socket and configuration in Terminal:SocketDirectory, the version check, and every tmux
// process started with the allowlisted environment, so tmux and the shell never see the API's secrets.
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Claushh.Api.Processes;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Claushh.Api.Terminal;

public sealed partial class TmuxServer(IOptions<TerminalOptions> options, ILogger<TmuxServer> log)
{
    public const string Unavailable = "Terminal unavailable";
    public const string Unresponsive = "Terminal not responding";
    public static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(10);

    private static readonly Version Minimum = new(3, 7);
    // A Unix socket path holds at most 107 bytes (sun_path is 108 with the final NUL).
    private const int MaxSocketPath = 107;
    // -f replaces the user's ~/.tmux.conf. history-limit matches the xterm scrollback (web xterm-loader.ts).
    private const string Configuration = """
        set -g history-limit 5000
        set -g remain-on-exit off
        set -g detach-on-destroy on
        set -g status off
        set -g default-terminal tmux-256color

        """;

    private string _directory = "";

    public bool Available { get; private set; }
    public string SocketPath => Path.Join(_directory, "tmux.sock");
    private string ConfigPath => Path.Join(_directory, "tmux.conf");

    // At start: checks tmux and the directory, writes the configuration and ends a server a previous run left behind.
    // Never throws: without a usable tmux the rest of the API works and the terminal answers "Terminal unavailable".
    public async Task PrepareAsync(CancellationToken ct)
    {
        Available = false;
        try
        {
            if (SocketDirectory() is not { } directory)
            {
                return;
            }
            _directory = directory;
            if (await VersionAsync(ct) is not { } version || version < Minimum)
            {
                log.LogError("The terminal needs tmux 3.7 or later on PATH (README.md, \"Running in development\").");
                return;
            }
            Directory.CreateDirectory(directory);
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            await File.WriteAllTextAsync(ConfigPath, Configuration, ct);
            // "no server running" is fine: there was nothing left.
            await RunAsync(["kill-server"], ct);
            File.Delete(SocketPath);
            Available = true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or Win32Exception or HubException)
        {
            log.LogError(e, "The terminal is unavailable: preparing the tmux server failed");
        }
    }

    // tmux with the API's socket and configuration and the allowlisted environment, plus COLORTERM and
    // Terminal:Environment. Every tmux process gets the same environment, so the server and every pane see only it.
    public ProcessStartInfo StartInfo(IEnumerable<string> arguments)
    {
        var start = new ProcessStartInfo("tmux");
        foreach (var argument in new[] { "-u", "-S", SocketPath, "-f", ConfigPath }.Concat(arguments))
        {
            start.ArgumentList.Add(argument);
        }
        var overrides = new Dictionary<string, string>(StringComparer.Ordinal) { ["COLORTERM"] = "truecolor" };
        foreach (var (name, value) in options.Value.Environment)
        {
            overrides[name] = value;
        }
        ChildEnvironment.Apply(start, overrides);
        return start;
    }

    // A one-off command (-V, kill-server, kill-session) within CommandTimeout: its exit code and stdout.
    public async Task<(int ExitCode, string Output)> RunAsync(IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var start = StartInfo(arguments);
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using var tmux = Process.Start(start)!;
        tmux.StandardInput.Close();
        var output = tmux.StandardOutput.ReadToEndAsync(ct);
        var errors = tmux.StandardError.ReadToEndAsync(ct);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(CommandTimeout);
        try
        {
            await tmux.WaitForExitAsync(limit.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                tmux.Kill();
            }
            catch (InvalidOperationException)
            {
                // It exited in the meantime.
            }
            throw new HubException(Unresponsive);
        }
        await errors;
        return (tmux.ExitCode, await output);
    }

    public async Task KillServerAsync()
    {
        if (!Available)
        {
            return;
        }
        try
        {
            await RunAsync(["kill-server"], CancellationToken.None);
        }
        catch (Exception e) when (e is HubException or IOException or Win32Exception)
        {
            log.LogWarning(e, "Ending the tmux server failed");
        }
    }

    private string? SocketDirectory()
    {
        var directory = options.Value.SocketDirectory
            ?? (Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") is { Length: > 0 } runtime ? Path.Join(runtime, "claushh") : null);
        if (directory is null || !Path.IsPathFullyQualified(directory))
        {
            log.LogError("Terminal:SocketDirectory is not an absolute path and XDG_RUNTIME_DIR is not set: the terminal is unavailable.");
            return null;
        }
        if (Encoding.UTF8.GetByteCount(Path.Join(directory, "tmux.sock")) > MaxSocketPath)
        {
            log.LogError("Terminal:SocketDirectory is too long for a Unix socket: with \"/tmux.sock\" at most {Bytes} bytes.", MaxSocketPath);
            return null;
        }
        return directory;
    }

    private async Task<Version?> VersionAsync(CancellationToken ct)
    {
        try
        {
            var (exitCode, output) = await RunAsync(["-V"], ct);
            var match = VersionPattern().Match(output);
            return exitCode == 0 && match.Success
                ? new Version(int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture))
                : null;
        }
        catch (Win32Exception)
        {
            // No tmux on PATH.
            return null;
        }
    }

    // "tmux 3.7c", "tmux next-3.8"; a build without a number ("tmux master") is refused.
    [GeneratedRegex(@"^tmux (?:next-)?(\d+)\.(\d+)")]
    private static partial Regex VersionPattern();
}
