using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Claushh.Api.Tests;

// Search in files (docs/ARCHITECTURE.md, "Files and editor" → "Search API contract"; "Backend" → "Files"): matching,
// columns and previews, globs, the path guard and links, skipped files, .gitignore, the limits, access, and a query that
// never reaches the logs.
public sealed class SearchTests(ApiFactory api) : ApiTest(api)
{
    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    private Task<HttpResponseMessage> PostAsync(object body) => Client.Http.PostAsJsonAsync("/api/search", body);

    private async Task<JsonElement> SearchOkAsync(object body)
    {
        var response = await PostAsync(body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    // Each match as "path:line:column preview [start,end]…".
    private static string[] Lines(JsonElement result) =>
    [
        .. result.GetProperty("files").EnumerateArray().SelectMany(file => file.GetProperty("matches").EnumerateArray().Select(match =>
            $"{file.GetProperty("path").GetString()}:{match.GetProperty("line").GetInt32()}:{match.GetProperty("column").GetInt32()} "
            + $"{match.GetProperty("preview").GetString()} "
            + string.Concat(match.GetProperty("ranges").EnumerateArray().Select(range => $"[{range[0].GetInt32()},{range[1].GetInt32()}]")))),
    ];

    private static string[] Paths(JsonElement result) =>
        [.. result.GetProperty("files").EnumerateArray().Select(file => file.GetProperty("path").GetString()!)];

    [Fact]
    public async Task A_literal_ignores_case_unless_match_case_and_whole_word_skips_parts_of_words()
    {
        Api.WriteProjectFile("lab/main.c", "int Main = main_loop + main;\n");

        var found = await SearchOkAsync(new { path = "lab", query = "main" });

        Assert.Equal(new[] { "lab/main.c:1:5 int Main = main_loop + main; [4,8][11,15][23,27]" }, Lines(found));
        Assert.Equal(3, found.GetProperty("matchCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, found.GetProperty("limit").ValueKind);
        Assert.Equal(new[] { "lab/main.c:1:12 int Main = main_loop + main; [11,15][23,27]" },
            Lines(await SearchOkAsync(new { path = "lab", query = "main", matchCase = true })));
        Assert.Equal(new[] { "lab/main.c:1:5 int Main = main_loop + main; [4,8][23,27]" },
            Lines(await SearchOkAsync(new { path = "lab", query = "main", wholeWord = true })));
        Assert.Equal(new[] { "lab/main.c:1:22 int Main = main_loop + main; [21,27]" },
            Lines(await SearchOkAsync(new { path = "lab", query = "+ main" })));
    }

    [Fact]
    public async Task A_regular_expression_matches_each_line_on_its_own_without_its_line_ending()
    {
        Api.WriteProjectFile("lab/parser.c", "int parse(void)\r\n{\r\n    return parsed;\r\n}\r\n");
        Api.WriteProjectFile("lab/main.c", "int main(void)\n{\n    parse();\n}\n");

        Assert.Equal(new[]
        {
            "lab/main.c:3:5 parse(); [0,5]",
            "lab/parser.c:1:5 int parse(void) [4,9]",
            "lab/parser.c:3:12 return parsed; [7,13]",
        }, Lines(await SearchOkAsync(new { path = "lab", query = @"pars\w+", regex = true })));
        Assert.Equal(new[] { "lab/main.c:3:12 parse(); [7,8]", "lab/parser.c:3:18 return parsed; [13,14]" },
            Lines(await SearchOkAsync(new { path = "lab", query = ";$", regex = true })));
        Assert.Empty(Lines(await SearchOkAsync(new { path = "lab", query = @"\)\s*\{", regex = true })));
    }

    [Fact]
    public async Task Columns_and_ranges_count_UTF16_units_and_a_long_line_is_cut_around_its_first_match()
    {
        Api.WriteProjectFile("pl/a.c", "\tzażółć 😀 main = main;\n");
        Api.WriteProjectFile("long/a.txt", new string('x', 100) + "needle" + new string('y', 300) + "needle\n");
        Api.WriteProjectFile("wide/a.txt", "needle" + new string('y', 300) + "\n");
        Api.WriteProjectFile("emoji/a.txt", string.Concat(Enumerable.Repeat("😀", 20)) + "aneedle\n");

        Assert.Equal(new[] { "pl/a.c:1:12 zażółć 😀 main = main; [10,14][17,21]" },
            Lines(await SearchOkAsync(new { path = "pl", query = "main" })));
        var cut = await SearchOkAsync(new { path = "long", query = "needle" });
        Assert.Equal(new[] { "long/a.txt:1:101 " + new string('x', 30) + "needle" + new string('y', 214) + " [30,36]" }, Lines(cut));
        Assert.Equal(2, cut.GetProperty("matchCount").GetInt32());
        Assert.Equal(new[] { "wide/a.txt:1:7 needle" + new string('y', 244) + " [6,250]" },
            Lines(await SearchOkAsync(new { path = "wide", query = "y+", regex = true })));
        Assert.Equal(new[] { "emoji/a.txt:1:42 " + string.Concat(Enumerable.Repeat("😀", 14)) + "aneedle [29,35]" },
            Lines(await SearchOkAsync(new { path = "emoji", query = "needle" })));
    }

    [Fact]
    public async Task Include_and_exclude_globs_are_relative_to_the_root_and_a_name_matches_at_any_depth()
    {
        foreach (var file in new[] { "lab/src/main.c", "lab/src/util.h", "lab/test/main_test.c", "lab/docs/notes.md", "lab/build/out.c" })
        {
            Api.WriteProjectFile(file, "needle\n");
        }

        async Task<string[]> FoundAsync(object body) => Paths(await SearchOkAsync(body));

        Assert.Equal(new[] { "lab/build/out.c", "lab/src/main.c", "lab/test/main_test.c" },
            await FoundAsync(new { path = "lab", query = "needle", include = "*.c" }));
        Assert.Equal(new[] { "lab/src/main.c", "lab/src/util.h" }, await FoundAsync(new { path = "lab", query = "needle", include = "src" }));
        Assert.Equal(new[] { "lab/src/util.h" }, await FoundAsync(new { path = "lab", query = "needle", include = "src/*.h" }));
        Assert.Equal(new[] { "lab/build/out.c", "lab/src/main.c", "lab/src/util.h" },
            await FoundAsync(new { path = "lab", query = "needle", exclude = "test, *.md" }));
        Assert.Equal(new[] { "lab/src/main.c", "lab/test/main_test.c" },
            await FoundAsync(new { path = "lab", query = "needle", include = "*.c", exclude = "build/" }));
        Assert.Equal(new[] { "lab/src/main.c" }, await FoundAsync(new { path = "lab/src", query = "needle", include = "*.c" }));
        Assert.Empty(await FoundAsync(new { path = "lab", query = "needle", include = "*.C" }));
    }

    [Fact]
    public async Task A_bad_body_path_query_or_glob_is_400_with_an_empty_body_and_a_root_that_is_not_a_directory_is_404()
    {
        Api.WriteProjectFile("lab/a.txt", "needle\n");
        Api.Link("lab/dangling", Api.ProjectPath("lab/nowhere"));
        var tooLong = new string('a', 1_001);

        foreach (var body in new object[]
                 {
                     new { path = "lab" },
                     new { query = "needle" },
                     new { path = "lab", query = "" },
                     new { path = "lab", query = tooLong },
                     new { path = "lab", query = "needle", include = tooLong },
                     new { path = "lab", query = "needle", exclude = tooLong },
                     new { path = "lab", query = "needle", include = "a/../b" },
                     new { path = "../etc", query = "needle" },
                     new { path = "lab/.git", query = "needle" },
                     new { path = "lab/dangling", query = "needle" },
                     new { path = "lab/dangling/deeper", query = "needle" },
                 })
        {
            var response = await PostAsync(body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("", await response.Content.ReadAsStringAsync());
        }
        foreach (var path in new[] { "lab/a.txt", "lab/missing" })
        {
            var response = await PostAsync(new { path, query = "needle" });
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("", await response.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await PostAsync(new { path = "lab", query = 5 })).StatusCode);
        Assert.Empty(Paths(await SearchOkAsync(new { path = "lab", query = new string('a', 1_000) })));
    }

    [Fact]
    public async Task Lookarounds_backreferences_and_broken_patterns_are_400_and_never_a_literal()
    {
        Api.WriteProjectFile("lab/a.txt", "(a)(?=b)\\1\n");

        foreach (var query in new[] { "a(?=b)", "(?<=a)b", @"(a)\1", "(?>a)", "(?(a)b|c)", @"\Ga", "(a", "[z-a]" })
        {
            var response = await PostAsync(new { path = "lab", query, regex = true });
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("", await response.Content.ReadAsStringAsync());
        }
        // The pattern must be valid on its own, not only inside the whole-word group.
        Assert.Equal(HttpStatusCode.BadRequest, (await PostAsync(new { path = "lab", query = "a)|(b", regex = true, wholeWord = true })).StatusCode);
        Assert.Equal(new[] { @"lab/a.txt:1:1 (a)(?=b)\1 [0,3]" }, Lines(await SearchOkAsync(new { path = "lab", query = "(a)" })));
    }

    [Fact]
    public async Task Links_that_lead_out_are_skipped_directory_links_are_not_entered_and_results_keep_their_own_paths()
    {
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.txt"), "needle outside\n");
        Api.WriteProjectFile("lab/src/real.c", "needle inside\n");
        Api.Link("lab/alias.c", "src/real.c");
        Api.Link("lab/loop", Api.ProjectPath("lab"));
        Api.Link("lab/to-outside", outside.Root);
        Api.Link("lab/to-secret", outside.Child("secret.txt"));
        Api.Link("lab/to-src", Api.ProjectPath("lab/src"));

        var response = await PostAsync(new { path = "lab", query = "needle" });
        var raw = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(new[] { "lab/alias.c", "lab/src/real.c" }, Paths(JsonDocument.Parse(raw).RootElement));
        Assert.DoesNotContain(outside.Root, raw, StringComparison.Ordinal);
        Assert.DoesNotContain(Api.ProjectsRoot, raw, StringComparison.Ordinal);
        Assert.DoesNotContain("outside", raw, StringComparison.Ordinal);
        // The root may itself be a link inside: the results keep the path the client sent.
        Assert.Equal(new[] { "lab/to-src/real.c" }, Paths(await SearchOkAsync(new { path = "lab/to-src", query = "needle" })));
        Assert.Equal(HttpStatusCode.BadRequest, (await PostAsync(new { path = "lab/to-outside", query = "needle" })).StatusCode);
    }

    [Fact]
    public async Task Binary_files_invalid_UTF8_and_files_over_1_MiB_are_skipped()
    {
        Api.WriteProjectFile("lab/text.txt", "needle\n");
        Api.WriteProjectFile("lab/nul.bin", [.. "needle"u8, 0, (byte)'\n']);
        Api.WriteProjectFile("lab/latin2.txt", [.. "needle "u8, 0xB3, (byte)'\n']);
        Api.WriteProjectFile("lab/big.txt", "needle\n" + new string('x', 1024 * 1024));
        Api.WriteProjectFile("lab/edge.txt", "needle" + new string('x', 1024 * 1024 - 7) + "\n");

        Assert.Equal(new[] { "lab/edge.txt", "lab/text.txt" }, Paths(await SearchOkAsync(new { path = "lab", query = "needle" })));
    }

    [Fact]
    public async Task Node_modules_and_what_git_ignores_are_skipped_tracked_files_and_directories_included()
    {
        var repo = Api.Git.Init("ws/repo");
        Api.Git.Commit(repo, ".gitignore", "*.log\nbuild/\n", "ignore");
        Api.WriteProjectFile("ws/repo/tracked.log", "needle\n");
        Api.Git.Run(repo, "add", "-f", "tracked.log");
        Api.Git.Run(repo, "commit", "-q", "-m", "tracked");
        Api.WriteProjectFile("ws/repo/src/main.c", "needle\n");
        Api.WriteProjectFile("ws/repo/app.log", "needle\n");
        Api.WriteProjectFile("ws/repo/build/out.c", "needle\n");
        Api.WriteProjectFile("ws/repo/node_modules/lib/index.js", "needle\n");
        Api.WriteProjectFile("ws/repo/src/node_modules/x.js", "needle\n");
        Api.WriteProjectFile("ws/loose/build/kept.c", "needle\n");
        Api.WriteProjectFile("ws/loose/node_modules/y.js", "needle\n");

        // build/ is a directory-only rule: it pins that libgit2 takes the trailing "/" as a directory.
        Assert.Equal(new[] { "ws/loose/build/kept.c", "ws/repo/src/main.c" }, Paths(await SearchOkAsync(new { path = "", query = "needle" })));
        Assert.Equal(new[] { "ws/repo/src/main.c" }, Paths(await SearchOkAsync(new { path = "ws/repo", query = "needle" })));
        Assert.Equal(new[] { "ws/repo/src/main.c" }, Paths(await SearchOkAsync(new { path = "ws/repo/src", query = "needle" })));
    }

    [Fact]
    public async Task At_2000_matches_the_search_stops_and_says_so()
    {
        Api.WriteProjectFile("lab/a.txt", string.Concat(Enumerable.Repeat("x\n", 1_500)));
        Api.WriteProjectFile("lab/b.txt", string.Concat(Enumerable.Repeat("x\n", 1_500)));

        var stopped = await SearchOkAsync(new { path = "lab", query = "x" });

        Assert.Equal("results", stopped.GetProperty("limit").GetString());
        Assert.Equal(2_000, stopped.GetProperty("matchCount").GetInt32());
        Assert.Equal(new[] { 1_500, 500 }, stopped.GetProperty("files").EnumerateArray().Select(file => file.GetProperty("matches").GetArrayLength()));

        Api.WriteProjectFile("lab/b.txt", string.Concat(Enumerable.Repeat("x\n", 500)));
        var exact = await SearchOkAsync(new { path = "lab", query = "x" });
        Assert.Equal(JsonValueKind.Null, exact.GetProperty("limit").ValueKind);
        Assert.Equal(2_000, exact.GetProperty("matchCount").GetInt32());
    }

    [Fact]
    public async Task A_search_past_its_time_limit_stops_with_the_results_so_far()
    {
        Api.WriteProjectFile("lab/a.txt", "needle\n");
        Api.SetSearchTime(TimeSpan.Zero);

        var result = await SearchOkAsync(new { path = "lab", query = "needle" });

        Assert.Equal("time", result.GetProperty("limit").GetString());
        Assert.Empty(Paths(result));
    }

    [Fact(Timeout = 60_000)]
    public async Task A_pathological_pattern_over_a_long_line_and_many_large_files_finishes_well_within_the_deadline()
    {
        Api.WriteProjectFile("lab/long.txt", new string('a', 50_000) + "!\n");
        var large = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat(new string('a', 99) + "!\n", 10_000)));
        for (var i = 0; i < 20; i++)
        {
            Api.WriteProjectFile($"lab/large/{i:D2}.txt", large);
        }
        var clock = Stopwatch.StartNew();

        var result = await SearchOkAsync(new { path = "lab", query = "(a+)+$", regex = true }).WaitAsync(TestContext.Current.CancellationToken);

        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), $"The search took {clock.Elapsed}.");
        Assert.Equal(0, result.GetProperty("matchCount").GetInt32());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("limit").ValueKind);
    }

    [Fact]
    public async Task Searching_needs_a_session_and_the_xsrf_token()
    {
        Api.WriteProjectFile("lab/a.txt", "needle\n");
        var stranger = new ApiClient(Api);

        Assert.Equal(HttpStatusCode.Unauthorized,
            (await stranger.Http.PostAsJsonAsync("/api/search", new { path = "lab", query = "needle" })).StatusCode);
        Client.SendXsrf = false;
        Assert.Equal(HttpStatusCode.BadRequest, (await PostAsync(new { path = "lab", query = "needle" })).StatusCode);
        Client.SendXsrf = true;
        Assert.Single(Paths(await SearchOkAsync(new { path = "lab", query = "needle" })));
    }

    [Fact]
    public async Task The_query_never_reaches_the_logs()
    {
        const string canary = "kanarek7f3a";
        Api.WriteProjectFile("lab/a.txt", $"{canary}\n");
        Api.Logs.Listen();

        var found = await PostAsync(new { path = "lab", query = canary });
        var broken = await PostAsync(new { path = "lab", query = canary + "(", regex = true });
        var unsupported = await PostAsync(new { path = "lab", query = canary + "(?=x)", regex = true });

        Assert.Equal(new[] { HttpStatusCode.OK, HttpStatusCode.BadRequest, HttpStatusCode.BadRequest },
            new[] { found.StatusCode, broken.StatusCode, unsupported.StatusCode });
        Assert.Equal("", await broken.Content.ReadAsStringAsync());
        Assert.Equal("", await unsupported.Content.ReadAsStringAsync());
        var entries = Api.Logs.Entries;
        // The capture works: the search's own summary line is there, at Debug.
        Assert.Contains(entries, entry => entry.Contains("Search in files", StringComparison.Ordinal));
        Assert.DoesNotContain(entries, entry => entry.Contains(canary, StringComparison.Ordinal));
    }
}
