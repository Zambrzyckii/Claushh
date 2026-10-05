using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;

namespace Claushh.Api.Tests;

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

    // The status code must not tell whether something exists outside the projects directory or in .git.
    [Theory]
    [InlineData("repo/to-secret/x")]
    [InlineData("repo/to-outside/missing/x")]
    [InlineData("repo/to-head/x")]
    [InlineData("repo/dangling/x")]
    public async Task A_path_through_a_link_that_leads_outside_into_git_or_nowhere_is_400_also_when_its_end_is_missing(string path)
    {
        Api.WriteProjectFile("repo/.git/HEAD", "ref: refs/heads/main\n");
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.txt"), "secret");
        Api.Link("repo/to-outside", outside.Root);
        Api.Link("repo/to-secret", outside.Child("secret.txt"));
        Api.Link("repo/to-head", Api.ProjectPath("repo/.git/HEAD"));
        Api.Link("repo/dangling", Api.ProjectPath("repo/nowhere"));

        Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync(path));
    }

    [Fact]
    public async Task A_path_through_a_link_to_an_outside_directory_that_cannot_be_searched_is_400()
    {
        // Directory permissions do not bind root.
        Assert.SkipWhen(Environment.IsPrivilegedProcess, "root can search every directory");
        using var outside = new OutsideDirectory();
        var locked = Directory.CreateDirectory(outside.Child("locked")).FullName;
        Api.Link("repo/to-locked", locked);
        File.SetUnixFileMode(locked, UnixFileMode.None);
        try
        {
            Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync("repo/to-locked/x"));
        }
        finally
        {
            // The directory has to be deletable when the OutsideDirectory is disposed.
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Theory]
    [InlineData("repo/to-locked")]
    [InlineData("repo/to-locked/x")]
    public async Task A_link_into_a_directory_of_the_projects_directory_that_cannot_be_searched_is_400(string path)
    {
        // Directory permissions do not bind root.
        Assert.SkipWhen(Environment.IsPrivilegedProcess, "root can search every directory");
        var locked = Directory.CreateDirectory(Api.ProjectPath("locked/inner")).Parent!.FullName;
        Api.Link("repo/to-locked", Api.ProjectPath("locked/inner"));
        File.SetUnixFileMode(locked, UnixFileMode.None);
        try
        {
            Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync(path));
        }
        finally
        {
            // ApiFactory.ResetAsync has to be able to delete it.
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("notes.txt")]
    [InlineData("missing/x")]
    [InlineData("notes.txt/x")]
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

    // A directory whose path only starts like the projects directory is not inside it.
    [Fact]
    public async Task A_link_to_a_sibling_directory_with_the_same_prefix_is_400_and_left_out_of_the_listing()
    {
        var sibling = Api.ProjectsRoot + "-sibling";
        Directory.CreateDirectory(sibling);
        try
        {
            File.WriteAllText(Path.Join(sibling, "file.txt"), "x");
            Api.WriteProjectFile("repo/kept.txt", "x");
            Api.Link("repo/to-sibling", sibling);

            Assert.Equal(HttpStatusCode.BadRequest, await ListStatusAsync("repo/to-sibling"));
            Assert.Equal(new[] { new Entry("kept.txt", "repo/kept.txt", "file") }, await ListAsync("repo"));
        }
        finally
        {
            Directory.Delete(sibling, recursive: true);
        }
    }

    // A second API instance on a fresh projects directory, so that the first request is the first use of the directory.
    [Fact]
    public async Task A_projects_directory_that_was_missing_at_the_first_request_is_used_once_it_is_back()
    {
        using var outside = new OutsideDirectory();
        var root = Directory.CreateDirectory(outside.Child("projects")).FullName;
        using var other = Api.WithWebHostBuilder(builder => builder.UseSetting("Projects:Root", root));
        using var http = other.CreateDefaultClient(ApiClient.BaseAddress, new CookieContainerHandler(Client.Cookies));
        Directory.Move(root, outside.Child("away"));

        Assert.Equal(HttpStatusCode.InternalServerError, (await http.GetAsync("/api/files/list?path=")).StatusCode);
        Directory.Move(outside.Child("away"), root);

        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/api/files/list?path=")).StatusCode);
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
