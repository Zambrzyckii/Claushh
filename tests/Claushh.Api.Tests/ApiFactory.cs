// One PostgreSQL 17 container and one API instance for the whole test run
// (docs/ARCHITECTURE.md, "Tests"). Tests run one at a time because they share the database.
using System.Diagnostics;
using System.Text;
using Claushh.Api.Data;
using Claushh.Api.Git;
using Claushh.Api.Terminal;
using Claushh.Api.Workspaces;
using LibGit2Sharp;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(Claushh.Api.Tests.ApiFactory))]
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]
// The backend runs only on Linux (docs/PLAN.md, "Backend decisions (stage 2)"); the tests use symlinks, FIFOs and Unix file modes.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]

namespace Claushh.Api.Tests;

public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string UserName = "owner";
    public const string Password = "correct horse battery";

    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("postgres:17").Build();

    public TestClock Clock { get; } = new();
    public string TotpKey { get; private set; } = "";

    // Codes follow the test clock, like the API (TotpVerifier). A code is accepted once, so every login takes a new step.
    public string NextTotp()
    {
        Clock.Advance(TimeSpan.FromSeconds(30));
        return CurrentTotp();
    }

    public string CurrentTotp() => TotpAt(TimeSpan.Zero);

    public string TotpAt(TimeSpan offset) => Totp.Code(TotpKey, Clock.GetUtcNow() + offset);

    // A code that none of the accepted steps (the one of the test clock and its neighbours) produces.
    public string WrongTotp()
    {
        var valid = new[] { -30, 0, 30 }.Select(seconds => TotpAt(TimeSpan.FromSeconds(seconds))).ToHashSet();
        return new[] { "000000", "111111", "222222", "333333" }.First(code => !valid.Contains(code));
    }

    // The projects directory of the test run (Projects:Root), emptied before every test.
    public string ProjectsRoot { get; } = Directory.CreateTempSubdirectory("claushh-projects-").FullName;

    public string ProjectPath(string relative) => Path.Join(ProjectsRoot, relative);

    public string WriteProjectFile(string relative, string text) => WriteProjectFile(relative, Encoding.UTF8.GetBytes(text));

    public string WriteProjectFile(string relative, byte[] bytes)
    {
        var path = ProjectPath(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
        return path;
    }

    public void Link(string relative, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ProjectPath(relative))!);
        File.CreateSymbolicLink(ProjectPath(relative), target);
    }

    public void MakeFifo(string relative)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ProjectPath(relative))!);
        using var mkfifo = Process.Start("mkfifo", ProjectPath(relative));
        mkfifo.WaitForExit();
        Assert.Equal(0, mkfifo.ExitCode);
    }

    // HOME of the git processes the tests start, and the only place libgit2 reads configuration from, so the machine's
    // ~/.gitconfig (signing, hooks, autocrlf) reaches neither the test repositories nor the API.
    public string GitHome { get; } = Directory.CreateTempSubdirectory("claushh-git-home-").FullName;

    // The API's tmux directory (Terminal:SocketDirectory) and the shell's HOME, both temporary, so the owner's own tmux
    // and dotfiles stay out of the tests.
    public string TmuxDirectory { get; } = Directory.CreateTempSubdirectory("claushh-tmux-").FullName;
    public string TerminalHome { get; } = Directory.CreateTempSubdirectory("claushh-home-").FullName;

    // Bare repositories that stand in for GitHub, and clones of them "on another computer"; emptied before every test.
    public string RemotesRoot { get; } = Directory.CreateTempSubdirectory("claushh-remotes-").FullName;

    public TestGit Git { get; }

    // The global git configuration of the test run: https://git.test/<name>.git leads to RemotesRoot, and the file
    // transport that this needs is allowed. TestGit sets its own HOME to GitHome, which resolves to this file by
    // itself; the API's git gets it through Git:Environment:GIT_CONFIG_GLOBAL (ConfigureWebHost), not through the
    // test process's own environment, which ChildEnvironment no longer passes through. The API's own
    // -c protocol.allow=never still refuses every other transport but https.
    public string GitConfig => Path.Join(GitHome, ".gitconfig");

    // Git:NetworkTimeout for the API; null: the configured value.
    private TimeSpan? _networkTimeout;

    public ApiFactory()
    {
        Git = new TestGit(this);
        // Never read by the API: the terminal tests check that they do not reach a shell. In production the API's
        // environment holds ConnectionStrings__Claushh.
        Environment.SetEnvironmentVariable("CLAUSHH_TEST_CANARY", "leak");
        Environment.SetEnvironmentVariable("ConnectionStrings__Canary", "leak");
        // libgit2 keeps these per process, and the API runs in this one.
        foreach (var level in new[] { ConfigurationLevel.Global, ConfigurationLevel.Xdg, ConfigurationLevel.System })
        {
            GlobalSettings.SetConfigSearchPaths(level, GitHome);
        }
        WriteGitConfig();
    }

    public void WriteGitConfig(bool allowFileTransport = true) =>
        File.WriteAllText(GitConfig, $"[url \"{RemotesRoot}/\"]\n\tinsteadOf = https://git.test/\n"
            + (allowFileTransport ? "[protocol \"file\"]\n\tallow = always\n" : ""));

    // The API reads Git:NetworkTimeout through IOptionsMonitor, so emptying its cache applies a new value at once.
    public void SetNetworkTimeout(TimeSpan? timeout)
    {
        _networkTimeout = timeout;
        Services.GetRequiredService<IOptionsMonitorCache<GitOptions>>().Clear();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Claushh", _db.GetConnectionString());
        builder.UseSetting("Projects:Root", ProjectsRoot);
        builder.UseSetting("Hubs:AllowedOrigins:0", TestHub.Origin);
        builder.UseSetting("Terminal:SocketDirectory", TmuxDirectory);
        builder.UseSetting("Terminal:Environment:SHELL", "/bin/sh");
        builder.UseSetting("Terminal:Environment:HOME", TerminalHome);
        builder.UseSetting("Git:Environment:GIT_CONFIG_GLOBAL", GitConfig);
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<TimeProvider>(Clock);
            services.AddSingleton<IStartupFilter, TestRemoteIp>();
            services.PostConfigure<GitOptions>(options => options.NetworkTimeout = _networkTimeout ?? options.NetworkTimeout);
            // Nested inside HubSessionFilter (registered after it here), so HubConnectionTests can make the connect
            // pipeline fail once the session check has passed (TestHubThrow).
            services.Configure<HubOptions>(options => options.AddFilter<TestHubThrow>());
        });
    }

    public async ValueTask InitializeAsync() => await _db.StartAsync();

    // Before every test: empty tables, projects and remotes directories, the clock at the current second, and (by
    // default) the owner with TOTP enabled.
    public async Task ResetAsync(bool withUser = true)
    {
        // The previous test's terminals end, and with the last one the tmux server.
        await Services.GetRequiredService<Terminals>().CloseAllAsync();
        // A fetch the previous test started in the background must not touch this test's repositories.
        await Services.GetRequiredService<BackgroundFetch>().ResetAsync();
        // Directory.Delete removes symlinks without following them, so link targets outside stay untouched.
        Directory.Delete(ProjectsRoot, recursive: true);
        Directory.CreateDirectory(ProjectsRoot);
        Directory.Delete(RemotesRoot, recursive: true);
        Directory.CreateDirectory(RemotesRoot);
        WriteGitConfig();
        SetNetworkTimeout(null);
        Clock.Reset();
        await using var scope = Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        await db.Database.ExecuteSqlRawAsync("""TRUNCATE "Sessions", "LoginAttempts", "AspNetUsers", "Workspaces" CASCADE""");
        if (!withUser)
        {
            return;
        }
        var users = scope.ServiceProvider.GetRequiredService<UserManager<IdentityUser>>();
        var user = new IdentityUser(UserName);
        Check(await users.CreateAsync(user, Password));
        Check(await users.ResetAuthenticatorKeyAsync(user));
        TotpKey = await users.GetAuthenticatorKeyAsync(user) ?? throw new InvalidOperationException("No TOTP key.");
        Check(await users.SetTwoFactorEnabledAsync(user, true));
    }

    public async Task<int> LoginAttemptCountAsync()
    {
        await using var scope = Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ClaushhDbContext>().LoginAttempts.CountAsync();
    }

    // A row of the Workspaces table, as creating a workspace leaves it (its directory is up to the test).
    public async Task AddWorkspaceRowAsync(string directory, string displayName, DateTimeOffset createdAt)
    {
        await using var scope = Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        db.Workspaces.Add(new Workspace { Directory = directory, DisplayName = displayName, CreatedAt = createdAt });
        await db.SaveChangesAsync();
    }

    // tmux on the test run's server, for what the hub does not offer (typing without Input, has-session). Its environment
    // is minimal, so nothing of this process reaches a server such a command might start.
    public (int ExitCode, string Output) Tmux(params string[] arguments)
    {
        var start = new ProcessStartInfo("tmux") { RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "-S", Path.Join(TmuxDirectory, "tmux.sock") }.Concat(arguments))
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment.Clear();
        start.Environment["PATH"] = Environment.GetEnvironmentVariable("PATH");
        start.Environment["HOME"] = TerminalHome;
        start.Environment["LANG"] = "C.UTF-8";
        using var tmux = Process.Start(start)!;
        tmux.ErrorDataReceived += (_, _) => { };
        tmux.BeginErrorReadLine();
        var output = tmux.StandardOutput.ReadToEnd();
        tmux.WaitForExit();
        return (tmux.ExitCode, output);
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _db.DisposeAsync();
        Directory.Delete(ProjectsRoot, recursive: true);
        Directory.Delete(TmuxDirectory, recursive: true);
        Directory.Delete(TerminalHome, recursive: true);
        Directory.Delete(RemotesRoot, recursive: true);
        Directory.Delete(GitHome, recursive: true);
    }

    private static void Check(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }
}
