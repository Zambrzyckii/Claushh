using Claushh.Api.Files;
using Claushh.Api.Terminal;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Claushh.Api.Tests;

public sealed class TerminalTests(ApiFactory api) : ApiTest(api)
{
    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Opens_in_the_real_directory_with_its_name_as_title()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab"));
        Api.Link("studia/link", Api.ProjectPath("studia/lab"));
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);

        var terminal = await tab.OpenAsync("studia/link");
        Type(terminal.Id, "pwd; echo kon''iec");

        Assert.Equal(new TestTerminal.Info(terminal.Id, "link", "studia/link", false), terminal);
        Assert.Matches("^[0-9a-f]{32}$", terminal.Id);
        var output = await tab.WaitForAsync(terminal.Id, "koniec");
        // No leading "\n" check: systemd's prompt hook (/etc/profile.d/80-systemd-osc-context.sh) writes an OSC 3008
        // sequence between the echoed command and its output.
        Assert.Contains(Path.Join(Api.Services.GetRequiredService<ProjectPaths>().Root, "studia", "lab") + "\r\n", output,
            StringComparison.Ordinal);
        Assert.Equal(new[] { terminal }, await tab.ListAsync());
    }

    [Fact]
    public async Task Titles_stay_unique_also_after_a_close()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);

        var first = await tab.OpenAsync();
        var second = await tab.OpenAsync();
        await tab.CloseAsync(first.Id);
        var third = await tab.OpenAsync();
        var fourth = await tab.OpenAsync();

        Assert.Equal(new[] { "projekty", "projekty (2)", "projekty", "projekty (3)" },
            new[] { first.Title, second.Title, third.Title, fourth.Title });
        Assert.Equal(new[] { second.Id, third.Id, fourth.Id }, (await tab.ListAsync()).Select(t => t.Id));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("..")]
    [InlineData("../etc")]
    [InlineData("/etc")]
    [InlineData("studia//lab")]
    [InlineData("studia/lab/.git")]
    [InlineData("studia/file.txt")]
    [InlineData("studia/missing")]
    public async Task Refuses_what_is_not_a_directory_in_the_projects_directory(string? projectPath)
    {
        Directory.CreateDirectory(Api.ProjectPath("studia/lab/.git"));
        Api.WriteProjectFile("studia/file.txt", "x");
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);

        var error = await Assert.ThrowsAsync<HubException>(() =>
            tab.Hub.InvokeAsync<TestTerminal.Info>("OpenTerminal", new { projectPath, cols = 80, rows = 24 }));

        Assert.EndsWith("Nieprawidłowa ścieżka", error.Message);
        Assert.Empty(await tab.ListAsync());
    }

    [Fact]
    public async Task The_21st_terminal_is_refused()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        for (var i = 0; i < 20; i++)
        {
            await tab.OpenAsync();
        }

        var error = await Assert.ThrowsAsync<HubException>(() => tab.OpenAsync());

        Assert.EndsWith("Za dużo terminali", error.Message);
        Assert.Equal(20, (await tab.ListAsync()).Length);
    }

    [Fact]
    public async Task Output_fragments_are_numbered_from_1_without_gaps()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();

        Type(terminal.Id, "seq 1 3000; echo kon''iec");

        var output = await tab.WaitForAsync(terminal.Id, "koniec");
        var seqs = tab.Outputs(terminal.Id).Select(o => o.Seq).ToArray();
        Assert.Equal(Enumerable.Range(1, seqs.Length).Select(i => (long)i), seqs);
        Assert.Contains("\r\n3000\r\n", output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_shell_gets_only_the_allowlisted_environment()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();

        Type(terminal.Id, "env; echo kon''iec");

        var output = await tab.WaitForAsync(terminal.Id, "koniec");
        Assert.DoesNotContain("CLAUSHH_TEST_CANARY", output);
        Assert.DoesNotContain("ConnectionStrings", output);
        Assert.Contains("COLORTERM=truecolor\r\n", output, StringComparison.Ordinal);
        Assert.Contains($"HOME={Api.TerminalHome}\r\n", output, StringComparison.Ordinal);
        Assert.Contains("TERM=tmux-256color\r\n", output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Exit_ends_the_terminal_after_its_last_output()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();

        Type(terminal.Id, "echo by''e; exit");

        var exit = await tab.WaitForExitAsync(terminal.Id);
        Assert.Null(exit.ExitCode);
        var events = tab.Events(terminal.Id);
        Assert.IsType<TestTerminal.Exit>(events[^1]);
        Assert.Contains("bye", string.Concat(events.OfType<TestTerminal.Output>().Select(o => o.Data)));
        Assert.True(Assert.Single(await tab.ListAsync()).Exited);
    }

    [Fact]
    public async Task Closing_ends_the_tmux_session_without_an_event_and_an_unknown_id_is_no_error()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();
        Assert.Equal(0, Api.Tmux("has-session", "-t", $"=claushh-{terminal.Id}").ExitCode);

        await tab.CloseAsync(terminal.Id);

        Assert.NotEqual(0, Api.Tmux("has-session", "-t", $"=claushh-{terminal.Id}").ExitCode);
        Assert.Empty(await tab.ListAsync());
        await Task.Delay(1000, TestContext.Current.CancellationToken);
        Assert.DoesNotContain(tab.Events(terminal.Id), e => e is TestTerminal.Exit);
        // As from a second tab that still shows it, and an id that never existed.
        await tab.CloseAsync(terminal.Id);
        await tab.CloseAsync("unknown");
    }

    [Fact]
    public async Task Closing_the_same_terminal_twice_does_not_throw()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();
        var session = Api.Services.GetRequiredService<Terminals>().Find(terminal.Id);

        await session.CloseAsync();
        await session.CloseAsync();
    }

    [Fact]
    public async Task Opening_while_closing_all_leaves_no_session_running()
    {
        var terminals = Api.Services.GetRequiredService<Terminals>();

        // Called directly (not through the hub), so this runs synchronously up to OpenAsync's first real await
        // (inside StartAsync), by which time the terminal is already in the list: CloseAllAsync below is guaranteed
        // to race the start, not merely follow it.
        var opening = terminals.OpenAsync("", 80, 24);
        await terminals.CloseAllAsync();

        string? id = null;
        try
        {
            id = (await opening).Id;
        }
        catch (HubException)
        {
            // Refused because the close raced the start: as valid as returning.
        }
        Assert.NotEqual(0, Api.Tmux("has-session", "-t", id is null ? "=none" : $"=claushh-{id}").ExitCode);
    }

    [Fact]
    public async Task The_start_routine_ends_a_server_left_by_a_previous_run()
    {
        Assert.Equal(0, Api.Tmux("-f", "/dev/null", "new-session", "-d", "-s", "leftover").ExitCode);

        await Api.Services.GetRequiredService<Terminals>().StartAsync(TestContext.Current.CancellationToken);

        Assert.NotEqual(0, Api.Tmux("has-session", "-t", "=leftover").ExitCode);
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var terminal = await tab.OpenAsync();
        Type(terminal.Id, "echo kon''iec");
        await tab.WaitForAsync(terminal.Id, "koniec");
    }

    // Types a line into the terminal's pane with the tmux CLI.
    private void Type(string id, string line)
    {
        Assert.Equal(0, Api.Tmux("send-keys", "-t", $"=claushh-{id}:", "-l", line).ExitCode);
        Assert.Equal(0, Api.Tmux("send-keys", "-t", $"=claushh-{id}:", "Enter").ExitCode);
    }
}
