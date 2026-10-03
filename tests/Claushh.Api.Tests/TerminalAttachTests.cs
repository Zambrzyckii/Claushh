using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Claushh.Api.Tests;

public sealed class TerminalAttachTests(ApiFactory api) : ApiTest(api)
{
    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task The_snapshot_has_the_screen_with_crlf_line_ends()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);
        await tab.TypeAsync(id, "printf 'x\\ny\\n'; echo kon''iec");
        await tab.WaitForAsync(id, "koniec");

        var snapshot = (await tab.AttachAsync(id)).Snapshot;

        Assert.Contains("\r\nx\r\ny\r\nkoniec\r\n", snapshot, StringComparison.Ordinal);
        Assert.DoesNotMatch("[^\r]\n", snapshot);
    }

    [Fact]
    public async Task Attaching_while_output_flows_gives_every_line_exactly_once()
    {
        await using var writer = await TestTerminal.ConnectAsync(Api, Client);
        await using var viewer = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await writer.OpenAsync()).Id;
        await writer.AttachAsync(id);

        await writer.TypeAsync(id, "i=0; while [ $i -lt 4000 ]; do i=$((i+1)); echo n$i; case $i in *00) sleep 0.05;; esac; done; echo kon''iec");
        var attachments = new List<TestTerminal.Attachment>();
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (!viewer.Text(id).Contains("koniec", StringComparison.Ordinal))
        {
            Assert.True(DateTime.UtcNow < deadline, "The counter did not finish within 60 s.");
            attachments.Add(await viewer.AttachAsync(id));
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        var fragments = viewer.Outputs(id);
        foreach (var attachment in attachments)
        {
            var later = string.Concat(fragments.Where(f => f.Seq > attachment.Seq).Select(f => f.Data));
            Assert.Equal(Enumerable.Range(1, 4000), Numbers(Plain(attachment.Snapshot).TrimEnd() + Plain(later)));
        }
        Assert.True(attachments.Count(a => Numbers(Plain(a.Snapshot)) is { Count: > 0 and < 4000 }) >= 3,
            "Fewer than 3 attaches while the counter ran.");
    }

    [Fact]
    public async Task Attach_restores_the_bracketed_paste_mode_of_the_program()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);

        await tab.TypeAsync(id, "printf '\\033[?2004h'; echo wl''aczone; cat");
        await tab.WaitForAsync(id, "wlaczone");
        var on = (await tab.AttachAsync(id)).Snapshot;
        await tab.InputAsync(id, "\u0003");
        await tab.TypeAsync(id, "printf '\\033[?2004l'; echo wy''laczone; cat");
        await tab.WaitForAsync(id, "wylaczone");
        var off = (await tab.AttachAsync(id)).Snapshot;
        await tab.InputAsync(id, "\u0003");

        Assert.Contains("\e[?2004h", on, StringComparison.Ordinal);
        Assert.DoesNotContain("\e[?2004h", off, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_batch_sent_again_with_the_same_seq_is_typed_once()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);

        await tab.InputAsync(id, "echo a''b\r", seq: 1);
        await tab.InputAsync(id, "echo a''b\r", seq: 1);
        await tab.InputAsync(id, "echo kon''iec\r", seq: 2);

        var output = await tab.WaitForAsync(id, "koniec");
        Assert.Single(Regex.Matches(output, "ab\r\n"));
    }

    [Fact]
    public async Task Input_needs_an_attach_on_the_same_connection()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        await using var other = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);

        var stolen = await Assert.ThrowsAsync<HubException>(() => other.InputAsync(id, "x", seq: 1, client: tab.Client));
        var own = await Assert.ThrowsAsync<HubException>(() => other.InputAsync(id, "x"));

        Assert.EndsWith("Najpierw Attach na tym połączeniu", stolen.Message);
        Assert.EndsWith("Najpierw Attach na tym połączeniu", own.Message);
    }

    [Fact]
    public async Task Attach_returns_the_last_accepted_batch_and_moves_the_view_to_the_new_connection()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);
        await tab.InputAsync(id, "a");
        await tab.InputAsync(id, "b");
        await tab.InputAsync(id, "\u0003");

        // The same view after a reconnect: a new connection, the same client.
        await using var reconnected = await TestTerminal.ConnectAsync(Api, Client);
        var again = await reconnected.AttachAsync(id, client: tab.Client);

        Assert.Equal(3, again.InputSeq);
        Assert.Equal(0, (await tab.AttachAsync(id, client: "another-view")).InputSeq);
        var late = await Assert.ThrowsAsync<HubException>(() => tab.InputAsync(id, "c"));
        Assert.EndsWith("Najpierw Attach na tym połączeniu", late.Message);
    }

    public static TheoryData<string?, long, string?> BadBatches => new()
    {
        { null, 1, "x" },
        { "", 1, "x" },
        { new string('c', 65), 1, "x" },
        { "view", 0, "x" },
        { "view", -1, "x" },
        { "view", 1, null },
        { "view", 1, new string('x', 4097) },
    };

    [Theory]
    [MemberData(nameof(BadBatches))]
    public async Task A_batch_outside_the_limits_is_refused(string? client, long seq, string? data)
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);

        var error = await Assert.ThrowsAsync<HubException>(() => tab.Hub.InvokeAsync("Input", new { id, client, seq, data }));

        Assert.EndsWith("Nieprawidłowa paczka", error.Message);
    }

    [Fact]
    public async Task Polish_letters_and_emoji_reach_the_shell_intact_across_several_send_keys_commands()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);
        // 150 × 14 bytes = 2100 bytes: three send-keys commands, with characters split between them.
        var text = string.Concat(Enumerable.Repeat("zażółć😀", 150));

        await tab.TypeAsync(id, "wc -c");
        await tab.InputAsync(id, text + "\r\u0004");

        var output = await tab.WaitForAsync(id, "\r\n2101\r\n");
        Assert.Contains(text, output, StringComparison.Ordinal);
        Assert.Contains(text, (await tab.AttachAsync(id, cols: 1000)).Snapshot, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Resize_sets_the_size_within_its_limits_and_an_unknown_id_is_ignored()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id, cols: 120, rows: 40);

        await tab.TypeAsync(id, "stty size; echo kon''iec1");
        Assert.Contains("40 120\r\n", await tab.WaitForAsync(id, "koniec1"), StringComparison.Ordinal);
        await tab.Hub.SendAsync("Resize", new { id, cols = 3, rows = 1 });
        await tab.TypeAsync(id, "stty size; echo kon''iec2");
        Assert.Contains("2 10\r\n", await tab.WaitForAsync(id, "koniec2"), StringComparison.Ordinal);
        await tab.Hub.SendAsync("Resize", new { id, cols = 5000, rows = 5000 });
        await tab.TypeAsync(id, "stty size; echo kon''iec3");
        Assert.Contains("500 1000\r\n", await tab.WaitForAsync(id, "koniec3"), StringComparison.Ordinal);
        await tab.Hub.SendAsync("Resize", new { id = "unknown", cols = 80, rows = 24 });
        Assert.Single(await tab.ListAsync());
    }

    [Fact]
    public async Task An_exited_terminal_attaches_with_an_empty_snapshot_and_skips_input()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);
        await tab.TypeAsync(id, "exit");
        await tab.WaitForExitAsync(id);

        var attachment = await tab.AttachAsync(id);
        await tab.InputAsync(id, "echo x\r");
        await tab.InputAsync("unknown", "x");

        Assert.Equal("", attachment.Snapshot);
        Assert.Equal(1, attachment.InputSeq);
    }

    [Fact]
    public async Task Attach_of_an_unknown_terminal_is_an_error()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);

        var error = await Assert.ThrowsAsync<HubException>(() => tab.AttachAsync("unknown"));

        Assert.EndsWith("Nieznany terminal", error.Message);
    }

    // A program on the alternate screen: the snapshot has the history and normal screen before the switch to the
    // alternate screen, and the program's own text after it; once the program ends, a new attach shows no trace of it.
    [Fact]
    public async Task Attach_of_the_alternate_screen_has_history_before_it_and_the_program_after_it()
    {
        await using var tab = await TestTerminal.ConnectAsync(Api, Client);
        var id = (await tab.OpenAsync()).Id;
        await tab.AttachAsync(id);
        await tab.TypeAsync(id, "seq 1 60; echo kon''iec");
        await tab.WaitForAsync(id, "koniec");

        await tab.TypeAsync(id, "less /etc/os-release");
        await tab.WaitForAsync(id, "NAME=");
        var snapshot = (await tab.AttachAsync(id)).Snapshot;
        var switchIndex = snapshot.IndexOf("\e[?1049h", StringComparison.Ordinal);

        Assert.True(switchIndex > 0, $"No switch to the alternate screen in:\n{snapshot}");
        Assert.Contains("\r\n60", snapshot[..switchIndex], StringComparison.Ordinal);
        Assert.Contains("NAME=", snapshot[switchIndex..], StringComparison.Ordinal);

        await tab.InputAsync(id, "q");
        await tab.WaitForAsync(id, "\e[?1049l");
        var after = (await tab.AttachAsync(id)).Snapshot;

        Assert.DoesNotContain("\e[?1049h", after, StringComparison.Ordinal);
    }

    // The text without escape sequences and CR, as a person reads it.
    private static string Plain(string text) =>
        Regex.Replace(text, @"\e\[[0-?]*[ -/]*[@-~]|\e\][^\a\e]*(?:\a|\e\\)|\e[=>]|\r", "");

    private static List<int> Numbers(string text) =>
        [.. Regex.Matches(text, @"n(\d+)").Select(m => int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture))];
}
