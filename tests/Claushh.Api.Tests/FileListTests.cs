using System.Net;
using System.Net.Http.Json;
using System.Runtime.Versioning;

namespace Claushh.Api.Tests;

// Linux only, like the backend (docs/PLAN.md, "Backend decisions (stage 2)"): symlinks, FIFOs and Unix file modes.
[SupportedOSPlatform("linux")]
public sealed class FileListTests(ApiFactory api) : ApiTest(api)
{
    public sealed record Entry(string Name, string Path, string Kind);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Lists_the_root_and_a_subdirectory_with_dotfiles_but_without_git()
    {
        Api.WriteProjectFile("notes.txt", "x");
        Api.WriteProjectFile("studia/lab/main.c", "int main() {}\n");
        Api.WriteProjectFile("studia/lab/.gitignore", "bin/\n");
        Api.WriteProjectFile("studia/lab/.git/HEAD", "ref: refs/heads/main\n");
        Api.WriteProjectFile("studia/sub/.git", "gitdir: ../lab/.git/modules/sub\n");

        Assert.Equal(new[] { new Entry("notes.txt", "notes.txt", "file"), new Entry("studia", "studia", "directory") },
            Sorted(await ListAsync("")));
        Assert.Equal(new[] { new Entry(".gitignore", "studia/lab/.gitignore", "file"), new Entry("main.c", "studia/lab/main.c", "file") },
            Sorted(await ListAsync("studia/lab")));
        Assert.Empty(await ListAsync("studia/sub"));
    }

    [Fact(Timeout = 30_000)]
    public async Task Symlinks_inside_keep_their_targets_kind_and_every_other_link_or_special_file_is_hidden()
    {
        Api.WriteProjectFile("repo/src/app.c", "");
        Api.WriteProjectFile("repo/.git/HEAD", "ref: refs/heads/main\n");
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.txt"), "secret");
        Api.Link("repo/to-src", Api.ProjectPath("repo/src"));
        Api.Link("repo/to-app", "src/app.c");
        Api.Link("repo/to-outside", outside.Root);
        Api.Link("repo/to-secret", outside.Child("secret.txt"));
        Api.Link("repo/dangling", Api.ProjectPath("repo/nowhere"));
        Api.Link("repo/loop", Api.ProjectPath("repo/loop"));
        Api.Link("repo/to-git", Api.ProjectPath("repo/.git"));
        Api.MakeFifo("repo/pipe");

        Assert.Equal(new[]
            {
                new Entry("src", "repo/src", "directory"),
                new Entry("to-app", "repo/to-app", "file"),
                new Entry("to-src", "repo/to-src", "directory"),
            },
            Sorted(await ListAsync("repo").WaitAsync(TestContext.Current.CancellationToken)));
        Assert.Equal(new[] { new Entry("app.c", "repo/to-src/app.c", "file") },
            await ListAsync("repo/to-src").WaitAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_directory_behind_a_symlink_that_leads_outside_is_400()
    {
        using var outside = new OutsideDirectory();
        Directory.CreateDirectory(outside.Child("inner"));
        Api.Link("repo/to-outside", outside.Root);

        Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync("repo/to-outside"));
        Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync("repo/to-outside/inner"));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("notes.txt")]
    public async Task A_missing_directory_or_a_file_is_404(string path)
    {
        Api.WriteProjectFile("notes.txt", "x");

        Assert.Equal(HttpStatusCode.NotFound, await ListStatusAsync(path));
    }

    [Theory]
    [InlineData("../etc")]
    [InlineData("/etc")]
    [InlineData("a/../a")]
    [InlineData("./a")]
    [InlineData("a/./b")]
    [InlineData("a\\b")]
    [InlineData("a//b")]
    [InlineData("a/")]
    [InlineData("a/\0")]
    [InlineData(".git")]
    [InlineData("a/.git")]
    [InlineData("a/.git/refs")]
    // 300 characters: more than the 255 bytes a file name may have.
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public async Task Bad_paths_and_git_are_400(string path)
    {
        Api.WriteProjectFile("a/b/file.txt", "x");
        Api.WriteProjectFile("a/.git/refs/heads/main", "0000000000000000000000000000000000000000\n");

        Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync(path));
    }

    [Fact]
    public async Task A_directory_that_cannot_be_searched_lists_as_empty_and_what_is_under_it_is_404()
    {
        // Directory permissions do not bind root.
        Assert.SkipWhen(Environment.IsPrivilegedProcess, "root can search every directory");
        Api.WriteProjectFile("locked/inner/file.txt", "x");
        var locked = Api.ProjectPath("locked");
        File.SetUnixFileMode(locked, UnixFileMode.None);
        try
        {
            Assert.Empty(await ListAsync("locked"));
            Assert.Equal(HttpStatusCode.NotFound, await ListStatusAsync("locked/inner"));
            Assert.Equal(HttpStatusCode.NotFound, await ListStatusAsync("locked/missing"));
        }
        finally
        {
            // The reset of the next test has to be able to delete the directory.
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Fact]
    public async Task Listing_needs_a_session()
    {
        var stranger = new ApiClient(Api);

        Assert.Equal(HttpStatusCode.Unauthorized, (await stranger.Http.GetAsync("/api/files/list?path=")).StatusCode);
    }

    private static IEnumerable<Entry> Sorted(IEnumerable<Entry> entries) => entries.OrderBy(e => e.Name, StringComparer.Ordinal);

    private Task<HttpResponseMessage> GetListAsync(string path) =>
        Client.Http.GetAsync($"/api/files/list?path={Uri.EscapeDataString(path)}");

    private async Task<HttpStatusCode> ListStatusAsync(string path) => (await GetListAsync(path)).StatusCode;

    private async Task<List<Entry>> ListAsync(string path)
    {
        var response = await GetListAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<List<Entry>>())!;
    }
}
