using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Claushh.Api.Tests;

// The terminal's colours from pywal (docs/ARCHITECTURE.md, "Terminal" → "Terminal theme API contract"; "Backend" →
// "Terminal"): exactly the 19 colours of Terminal:ThemeFile in lower case, read on every request; 204 with an empty
// body for everything else; nothing of the file or its path in a response or a log.
public sealed class TerminalThemeTests(ApiFactory api) : ApiTest(api)
{
    // A colors.json as pywal16 writes it (its templates/colors.json), with upper-case digits, which the API lowers.
    private const string Pywal = """
        {
            "checksum": "9f2c4e1b7a3d5c6e",
            "wallpaper": "/srv/wallpapers/kanarek-7f3a.png",
            "alpha": "100",

            "special": {
                "background": "#0B0E14",
                "foreground": "#C5C8C6",
                "cursor": "#F0C674"
            },
            "colors": {
                "color0": "#0B0E14",
                "color1": "#CC6666",
                "color2": "#B5BD68",
                "color3": "#F0C674",
                "color4": "#81A2BE",
                "color5": "#B294BB",
                "color6": "#8ABEB7",
                "color7": "#C5C8C6",
                "color8": "#4D5057",
                "color9": "#D54E53",
                "color10": "#B9CA4A",
                "color11": "#E7C547",
                "color12": "#7AA6DA",
                "color13": "#C397D8",
                "color14": "#70C0B1",
                "color15": "#EAEAEA"
            }
        }
        """;

    // The whole body for Pywal: its 19 colours in lower case and nothing else.
    private const string Expected =
        """{"background":"#0b0e14","foreground":"#c5c8c6","cursor":"#f0c674","palette":["#0b0e14","#cc6666","#b5bd68","#f0c674","#81a2be","#b294bb","#8abeb7","#c5c8c6","#4d5057","#d54e53","#b9ca4a","#e7c547","#7aa6da","#c397d8","#70c0b1","#eaeaea"]}""";

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    // Terminal:ThemeFile set to a path under the projects directory; returns that path.
    private string UseThemeFile(string relative)
    {
        var path = Api.ProjectPath(relative);
        Api.SetThemeFile(path);
        return path;
    }

    // The status and body of GET /api/terminal/theme; given up when the test's timeout cancels its token.
    private async Task<(HttpStatusCode Status, string Body)> GetAsync()
    {
        var response = await Client.Http.GetAsync("/api/terminal/theme").WaitAsync(TestContext.Current.CancellationToken);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    // A 204 with an empty body; `name` says which case failed.
    private async Task NoThemeAsync(string name)
    {
        var (status, body) = await GetAsync();
        Assert.Equal((name, HttpStatusCode.NoContent, ""), (name, status, body));
    }

    [Fact]
    public async Task The_theme_needs_a_session_and_a_get_passes_the_xsrf_rule_without_a_token()
    {
        Api.WriteProjectFile("theme/colors.json", Pywal);
        UseThemeFile("theme/colors.json");

        Assert.Equal(HttpStatusCode.Unauthorized, (await new ApiClient(Api).Http.GetAsync("/api/terminal/theme")).StatusCode);
        // ApiClient sends the token only with other methods, and a stale one changes nothing on a GET.
        Assert.Equal((HttpStatusCode.OK, Expected), await GetAsync());
        using var stale = new HttpRequestMessage(HttpMethod.Get, "/api/terminal/theme");
        stale.Headers.Add("X-XSRF-TOKEN", "stale");
        Assert.Equal(HttpStatusCode.OK, (await Client.Http.SendAsync(stale)).StatusCode);
    }

    [Fact]
    public async Task Without_the_option_the_answer_is_204_with_an_empty_body_and_no_store()
    {
        foreach (var path in new string?[] { null, "" })
        {
            Api.SetThemeFile(path);
            var response = await Client.Http.GetAsync("/api/terminal/theme");
            Assert.Equal((path, HttpStatusCode.NoContent, ""), (path, response.StatusCode, await response.Content.ReadAsStringAsync()));
            Assert.True(response.Headers.CacheControl?.NoStore);
        }
    }

    [Fact]
    public async Task Pywals_file_gives_exactly_its_19_colours_in_lower_case_and_nothing_else()
    {
        Api.WriteProjectFile("theme/colors.json", Pywal);
        var path = UseThemeFile("theme/colors.json");

        var response = await Client.Http.GetAsync("/api/terminal/theme");
        var body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Expected, body);
        foreach (var other in new[] { "wallpaper", "kanarek", "checksum", "alpha", "special", "colors", path })
        {
            Assert.DoesNotContain(other, body, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task A_link_is_followed_to_the_file()
    {
        Api.WriteProjectFile("theme/real/colors.json", Pywal);
        Api.Link("theme/absolute.json", Api.ProjectPath("theme/real/colors.json"));
        Api.Link("theme/relative.json", "real/colors.json");
        Api.Link("theme/chain.json", Api.ProjectPath("theme/relative.json"));

        foreach (var link in new[] { "theme/absolute.json", "theme/relative.json", "theme/chain.json" })
        {
            UseThemeFile(link);
            var (status, body) = await GetAsync();
            Assert.Equal((link, HttpStatusCode.OK, Expected), (link, status, body));
        }
    }

    [Fact]
    public async Task A_change_to_the_file_is_seen_by_the_next_request()
    {
        Api.WriteProjectFile("theme/colors.json", Pywal);
        UseThemeFile("theme/colors.json");
        Assert.Equal((HttpStatusCode.OK, Expected), await GetAsync());

        Api.WriteProjectFile("theme/colors.json", Pywal.Replace("#0B0E14", "#1D1F21"));
        Assert.Equal((HttpStatusCode.OK, Expected.Replace("#0b0e14", "#1d1f21")), await GetAsync());

        File.Delete(Api.ProjectPath("theme/colors.json"));
        await NoThemeAsync("deleted");
    }

    // An unreadable file and a link loop are 204, never a 500.
    [Fact(Timeout = 30_000)]
    public async Task Anything_but_a_readable_regular_file_is_204()
    {
        Api.WriteProjectFile("theme/colors.json", Pywal);
        Directory.CreateDirectory(Api.ProjectPath("theme/directory"));
        Api.Link("theme/to-directory", Api.ProjectPath("theme/directory"));
        Api.Link("theme/dangling", Api.ProjectPath("theme/nowhere.json"));
        Api.Link("theme/loop", Api.ProjectPath("theme/loop"));
        File.SetUnixFileMode(Api.WriteProjectFile("theme/unreadable.json", Pywal), UnixFileMode.None);

        foreach (var path in new[]
                 {
                     Api.ProjectPath("theme/missing.json"), Api.ProjectPath("theme/dangling"), Api.ProjectPath("theme/loop"),
                     Api.ProjectPath("theme/directory"), Api.ProjectPath("theme/to-directory"),
                     Api.ProjectPath("theme/unreadable.json"), "/dev/zero",
                 })
        {
            Api.SetThemeFile(path);
            await NoThemeAsync(path);
        }
        // The file next to them is read, so their 204 is not the answer to everything.
        UseThemeFile("theme/colors.json");
        Assert.Equal((HttpStatusCode.OK, Expected), await GetAsync().WaitAsync(TestContext.Current.CancellationToken));
    }

    [Fact(Timeout = 30_000)]
    public async Task A_named_pipe_is_204_at_once_also_with_a_whole_theme_in_it()
    {
        Api.MakeFifo("theme/pipe");
        Api.Link("theme/to-pipe", Api.ProjectPath("theme/pipe"));
        var pipe = Api.ProjectPath("theme/pipe");
        try
        {
            // No writer: an open that waited for one would never return.
            foreach (var path in new[] { "theme/pipe", "theme/to-pipe" })
            {
                UseThemeFile(path);
                await NoThemeAsync(path);
            }
            // A whole theme, then the pipe's end: the writer is closed, so a reader that skipped the type check would
            // read the theme and its end and answer 200. A read-write open never waits on Linux, and the read-only
            // keeper holds the content after the writer closes.
            var writer = new FileStream(pipe, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            await using var keeper = new FileStream(pipe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            await using (writer)
            {
                await writer.WriteAsync(Encoding.UTF8.GetBytes(Pywal));
            }
            UseThemeFile("theme/pipe");
            await NoThemeAsync("a pipe with a whole theme in it").WaitAsync(TestContext.Current.CancellationToken);
        }
        finally
        {
            // A request still waiting in open() gets a writer here, and the pipe's end when it closes.
            using (new FileStream(pipe, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
            {
            }
        }
    }

    [Fact]
    public async Task Sixteen_KiB_are_read_and_one_byte_more_is_204()
    {
        var padding = 16 * 1024 - Encoding.UTF8.GetByteCount(Pywal);
        Api.WriteProjectFile("theme/exact.json", Pywal + new string(' ', padding));
        Api.WriteProjectFile("theme/over.json", Pywal + new string(' ', padding + 1));

        UseThemeFile("theme/exact.json");
        Assert.Equal((HttpStatusCode.OK, Expected), await GetAsync());
        UseThemeFile("theme/over.json");
        await NoThemeAsync("16 KiB and one byte");
    }

    // Valid JSON of another shape, invalid UTF-8 and NUL are 204, never a 500.
    [Fact]
    public async Task A_file_that_is_not_one_json_object_in_utf8_is_204()
    {
        var bytes = Encoding.UTF8.GetBytes(Pywal);
        byte[] invalid = [.. bytes];
        // Inside the background's value, so only the decoding can refuse it.
        invalid[Pywal.IndexOf("#0B0E14", StringComparison.Ordinal) + 2] = 0xB3;
        byte[] nul = [.. bytes];
        nul[Pywal.IndexOf("kanarek", StringComparison.Ordinal)] = 0;
        foreach (var (name, content) in new (string, byte[])[]
                 {
                     ("empty", Array.Empty<byte>()),
                     ("cut short", Encoding.UTF8.GetBytes(Pywal[..^10])),
                     ("a comment", Encoding.UTF8.GetBytes("// pywal\n" + Pywal)),
                     ("a trailing comma", Encoding.UTF8.GetBytes(Pywal.Replace("\"#EAEAEA\"", "\"#EAEAEA\","))),
                     ("two values", Encoding.UTF8.GetBytes(Pywal + Pywal)),
                     ("a list", "[]"u8.ToArray()),
                     ("a string", "\"#0b0e14\""u8.ToArray()),
                     ("null", "null"u8.ToArray()),
                     ("invalid UTF-8", invalid),
                     ("a NUL byte", nul),
                 })
        {
            Api.WriteProjectFile("theme/colors.json", content);
            UseThemeFile("theme/colors.json");
            await NoThemeAsync(name);
        }
    }

    [Theory]
    [InlineData("special", null)]
    [InlineData("special", "[]")]
    [InlineData("special", "\"#0b0e14\"")]
    [InlineData("colors", "null")]
    [InlineData("colors", "[\"#000000\"]")]
    [InlineData("special.cursor", null)]
    [InlineData("colors.color15", null)]
    [InlineData("special.background", "725524")]
    [InlineData("special.foreground", "null")]
    [InlineData("colors.color3", "true")]
    [InlineData("colors.color4", "{}")]
    [InlineData("colors.color0", "\"#12345\"")]
    [InlineData("colors.color1", "\"#1234567\"")]
    [InlineData("colors.color2", "\"123456\"")]
    [InlineData("colors.color5", "\"#12345g\"")]
    [InlineData("colors.color6", "\" #123456\"")]
    [InlineData("colors.color7", "\"#123456\\n\"")]
    [InlineData("colors.color9", "\"#１２３４５６\"")]
    [InlineData("colors.color10", "\"#fff\"")]
    public async Task A_section_or_value_that_is_missing_or_not_a_colour_is_204(string at, string? json)
    {
        var file = JsonNode.Parse(Pywal)!.AsObject();
        var parent = at.Split('.') is [var section, _] ? file[section]!.AsObject() : file;
        var key = at.Split('.')[^1];
        if (json is null)
        {
            parent.Remove(key);
        }
        else
        {
            parent[key] = JsonNode.Parse(json);
        }
        Api.WriteProjectFile("theme/colors.json", file.ToJsonString());
        UseThemeFile("theme/colors.json");

        await NoThemeAsync(at);
    }

    // No path, content or exception of any case reaches a log.
    [Fact]
    public async Task Nothing_of_the_file_or_its_path_reaches_the_logs()
    {
        const string canary = "kanarek7f3a";
        const string directory = $"theme-{canary}";
        Api.WriteProjectFile($"{directory}/colors.json", Pywal);
        Api.WriteProjectFile($"{directory}/cut.json", $"{{\"{canary}\": [");
        Api.WriteProjectFile($"{directory}/value.json", Pywal.Replace("\"#EAEAEA\"", $"\"{canary}\""));
        Api.WriteProjectFile($"{directory}/shape.json", $"{{\"special\": \"{canary}\", \"colors\": {{}}}}");
        Api.WriteProjectFile($"{directory}/bytes.json", [.. Encoding.UTF8.GetBytes($"\"{canary}"), 0xB3, (byte)'"']);
        File.SetUnixFileMode(Api.WriteProjectFile($"{directory}/unreadable.json", Pywal), UnixFileMode.None);
        Directory.CreateDirectory(Api.ProjectPath($"{directory}/directory"));
        Api.Link($"{directory}/loop", Api.ProjectPath($"{directory}/loop"));
        Api.Logs.Listen();

        var answers = new List<HttpStatusCode>();
        foreach (var name in new[] { "colors.json", "cut.json", "value.json", "shape.json", "bytes.json", "unreadable.json", "directory", "loop", "missing.json" })
        {
            UseThemeFile($"{directory}/{name}");
            answers.Add((await GetAsync()).Status);
        }

        Assert.Equal(new[] { HttpStatusCode.OK }.Concat(Enumerable.Repeat(HttpStatusCode.NoContent, 8)), answers);
        var entries = Api.Logs.Entries;
        // The capture works: the host logged the requests.
        Assert.Contains(entries, entry => entry.Contains("/api/terminal/theme", StringComparison.Ordinal));
        Assert.DoesNotContain(entries, entry => entry.Contains(canary, StringComparison.Ordinal));
    }
}
