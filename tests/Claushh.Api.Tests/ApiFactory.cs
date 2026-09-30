// One PostgreSQL 17 container and one API instance for the whole test run
// (docs/ARCHITECTURE.md, "Tests"). Tests run one at a time because they share the database.
using System.Diagnostics;
using System.Text;
using Claushh.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(Claushh.Api.Tests.ApiFactory))]
[assembly: Xunit.v3.Parallelization(Mode = Xunit.Sdk.ParallelMode.None)]

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

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Claushh", _db.GetConnectionString());
        builder.UseSetting("Projects:Root", ProjectsRoot);
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<TimeProvider>(Clock);
            services.AddSingleton<IStartupFilter, TestRemoteIp>();
        });
    }

    public async ValueTask InitializeAsync() => await _db.StartAsync();

    // Before every test: empty tables and projects directory, the clock at the current second, and (by default) the
    // owner with TOTP enabled.
    public async Task ResetAsync(bool withUser = true)
    {
        // Directory.Delete removes symlinks without following them, so link targets outside stay untouched.
        Directory.Delete(ProjectsRoot, recursive: true);
        Directory.CreateDirectory(ProjectsRoot);
        Clock.Reset();
        await using var scope = Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ClaushhDbContext>();
        await db.Database.ExecuteSqlRawAsync("""TRUNCATE "Sessions", "LoginAttempts", "AspNetUsers" CASCADE""");
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

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _db.DisposeAsync();
        Directory.Delete(ProjectsRoot, recursive: true);
    }

    private static void Check(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => e.Description)));
        }
    }
}
