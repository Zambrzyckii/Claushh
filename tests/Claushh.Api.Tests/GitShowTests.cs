using System.Net;
using System.Net.Http.Json;
using System.Text;

namespace Claushh.Api.Tests;

public sealed class GitShowTests(ApiFactory api) : ApiTest(api)
{
    private const int MaxBytes = 5 * 1024 * 1024;

    public sealed record ShowBody(string Content);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Shows_what_head_has_whatever_is_on_disk()
    {
        var lab = Api.Git.MakeRepo("studia/lab");
        Api.Git.Commit(lab, "src/main.c", "v1\n", "v1");
        Api.Git.Commit(lab, "gone.c", "gone\n", "gone");
        Api.WriteProjectFile("studia/lab/src/main.c", "v2, saved later\n");
        File.Delete(Api.ProjectPath("studia/lab/gone.c"));

        Assert.Equal("v1\n", await ShowOkAsync("studia/lab", "studia/lab/src/main.c"));
        Assert.Equal("gone\n", await ShowOkAsync("studia/lab", "studia/lab/gone.c"));
    }

    [Fact]
    public async Task Text_is_read_like_the_files_api_with_the_line_endings_of_a_checkout()
    {
        var lab = Api.Git.MakeRepo("studia/lab");
        Api.WriteProjectFile("studia/lab/.gitattributes", "*.crlf text eol=crlf\n");
        Api.WriteProjectFile("studia/lab/bom.txt", [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes("zażółć\n")]);
        Api.WriteProjectFile("studia/lab/windows.txt", "a\r\nb\r\n");
        Api.WriteProjectFile("studia/lab/unix.crlf", "one\ntwo\n");
        Api.Git.CommitAll(lab, "text");

        Assert.Equal("zażółć\n", await ShowOkAsync("studia/lab", "studia/lab/bom.txt"));
        Assert.Equal("a\r\nb\r\n", await ShowOkAsync("studia/lab", "studia/lab/windows.txt"));
        Assert.Equal("one\r\ntwo\r\n", await ShowOkAsync("studia/lab", "studia/lab/unix.crlf"));
    }

    [Fact]
    public async Task Binary_or_not_utf8_is_415_and_over_5_MB_is_413()
    {
        var lab = Api.Git.MakeRepo("studia/lab");
        Api.WriteProjectFile("studia/lab/nul.dat", [0x61, 0x00, 0x62]);
        Api.WriteProjectFile("studia/lab/cp1250.txt", [0x7A, 0xB3, 0x6F]); // "zło" in Windows-1250
        Api.WriteProjectFile("studia/lab/exact.txt", Enumerable.Repeat((byte)'a', MaxBytes).ToArray());
        Api.WriteProjectFile("studia/lab/over.txt", Enumerable.Repeat((byte)'a', MaxBytes + 1).ToArray());
        Api.Git.CommitAll(lab, "binary and big");

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await ShowAsync("studia/lab", "studia/lab/nul.dat")).StatusCode);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await ShowAsync("studia/lab", "studia/lab/cp1250.txt")).StatusCode);
        Assert.Equal(MaxBytes, (await ShowOkAsync("studia/lab", "studia/lab/exact.txt")).Length);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await ShowAsync("studia/lab", "studia/lab/over.txt")).StatusCode);
    }

    [Fact]
    public async Task What_head_has_no_file_for_is_404()
    {
        var lab = Api.Git.MakeRepo("studia/lab");
        Api.Git.Commit(lab, "src/main.c", "x\n", "src");
        Api.Link("studia/lab/link", "README.md");
        Api.Git.CommitAll(lab, "link");
        Api.WriteProjectFile("studia/lab/new.c", "not committed\n");
        Api.Git.Init("studia/empty");
        Api.WriteProjectFile("studia/empty/a.txt", "x");

        foreach (var (repo, path) in new[]
                 {
                     ("studia/lab", "studia/lab/new.c"), ("studia/lab", "studia/lab/src"), ("studia/lab", "studia/lab/link"),
                     ("studia/empty", "studia/empty/a.txt"), ("studia/nope", "studia/nope/a.txt"),
                 })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await ShowAsync(repo, path)).StatusCode);
        }
    }

    [Fact]
    public async Task A_path_outside_the_repository_or_not_a_valid_path_is_400()
    {
        Api.Git.MakeRepo("studia/lab");
        Api.Git.MakeRepo("studia/other");
        using var outside = new OutsideDirectory();
        File.WriteAllText(outside.Child("secret.txt"), "secret");
        Api.Link("studia/lab/out", outside.Root);

        foreach (var (repo, path) in new[]
                 {
                     ("studia/lab", "studia/other/README.md"), ("studia/lab", "studia/labx/README.md"), ("studia/lab", "studia/lab"),
                     ("studia/lab", "studia/lab/../lab/README.md"), ("studia/lab", "studia/lab/.git/config"),
                     ("studia/lab", "studia/lab/out/secret.txt"), ("studia", "studia/lab/README.md"),
                 })
        {
            Assert.Equal(HttpStatusCode.BadRequest, (await ShowAsync(repo, path)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.GetAsync("/api/git/show?repo=studia%2Flab")).StatusCode);
    }

    [Fact]
    public async Task Showing_needs_a_session()
    {
        Api.Git.MakeRepo("studia/lab");

        var response = await new ApiClient(Api).Http.GetAsync("/api/git/show?repo=studia%2Flab&path=studia%2Flab%2FREADME.md");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private Task<HttpResponseMessage> ShowAsync(string repo, string path) =>
        Client.Http.GetAsync($"/api/git/show?repo={Uri.EscapeDataString(repo)}&path={Uri.EscapeDataString(path)}");

    private async Task<string> ShowOkAsync(string repo, string path)
    {
        var response = await ShowAsync(repo, path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ShowBody>())!.Content;
    }
}
