using System.Net;
using System.Net.Http.Json;

namespace Claushh.Api.Tests;

public sealed class WorkspaceTests(ApiFactory api) : ApiTest(api)
{
    public sealed record WorkspaceBody(string Name, string Path, int RepoCount);
    public sealed record MessageBody(string Message);

    public override async ValueTask InitializeAsync()
    {
        await base.InitializeAsync();
        await Client.LoginAsOwnerAsync();
    }

    [Fact]
    public async Task Lists_directories_with_names_in_creation_order_then_the_others_by_directory_name()
    {
        var start = Api.Clock.GetUtcNow();
        await Api.AddWorkspaceRowAsync("studia", "Studia", start);
        await Api.AddWorkspaceRowAsync("prywatne", "Prywatne", start.AddMinutes(1));
        await Api.AddWorkspaceRowAsync("usuniety", "Usunięty", start.AddMinutes(2));
        Api.Git.MakeRepo("studia/lab");
        Api.Git.MakeRepo("studia/so");
        Directory.CreateDirectory(Api.ProjectPath("studia/plain"));
        Api.WriteProjectFile("studia/worktree/.git", "gitdir: ../lab/.git\n");
        Directory.CreateDirectory(Api.ProjectPath("prywatne"));
        Directory.CreateDirectory(Api.ProjectPath("Zeta"));
        Directory.CreateDirectory(Api.ProjectPath("alpha"));
        Directory.CreateDirectory(Api.ProjectPath(".config"));
        Api.WriteProjectFile("notes.txt", "x");
        Api.Link("linked", Api.ProjectPath("studia"));

        Assert.Equal(new[]
            {
                new WorkspaceBody("Studia", "studia", 2),
                new WorkspaceBody("Prywatne", "prywatne", 0),
                new WorkspaceBody("alpha", "alpha", 0),
                new WorkspaceBody("Zeta", "Zeta", 0),
            },
            await ListAsync());
    }

    [Fact]
    public async Task Creating_makes_the_directory_and_keeps_the_name_as_typed()
    {
        var first = await CreateAsync("  Zażółć gęślą jaźń ");
        Api.Clock.Advance(TimeSpan.FromSeconds(1));
        var second = await CreateAsync("Projekty zespołowe");

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(new WorkspaceBody("Zażółć gęślą jaźń", "zazolc-gesla-jazn", 0), await first.Content.ReadFromJsonAsync<WorkspaceBody>());
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.True(Directory.Exists(Api.ProjectPath("zazolc-gesla-jazn")));
        // In creation order, not by name.
        Assert.Equal(new[]
            {
                new WorkspaceBody("Zażółć gęślą jaźń", "zazolc-gesla-jazn", 0),
                new WorkspaceBody("Projekty zespołowe", "projekty-zespolowe", 0),
            },
            await ListAsync());
        // The panel selects the new workspace at once: its repository list must be empty, not 404.
        Assert.Equal("[]", await Client.Http.GetStringAsync("/api/repos?workspace=projekty-zespolowe"));
    }

    [Fact]
    public async Task A_name_counts_code_points_and_a_stale_row_is_taken_over()
    {
        var start = Api.Clock.GetUtcNow();
        await Api.AddWorkspaceRowAsync("stary", "Stary", start.AddMinutes(-10));
        await Api.AddWorkspaceRowAsync("studia", "Studia", start.AddMinutes(-5));
        Directory.CreateDirectory(Api.ProjectPath("studia"));
        // 40 code points, 41 UTF-16 characters: the last one is outside the BMP and leaves no trace in the directory.
        var longest = new string('a', 39) + "\U0001D400";

        var stale = await CreateAsync("STARY");
        Api.Clock.Advance(TimeSpan.FromSeconds(1));
        var counted = await CreateAsync(longest);

        Assert.Equal(HttpStatusCode.Created, stale.StatusCode);
        Assert.Equal(HttpStatusCode.Created, counted.StatusCode);
        Assert.Equal(new[]
            {
                new WorkspaceBody("Studia", "studia", 0),
                new WorkspaceBody("STARY", "stary", 0),
                new WorkspaceBody(longest, new string('a', 39), 0),
            },
            await ListAsync());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("a\tb")]
    [InlineData("../hack")]
    [InlineData("ß")]
    [InlineData("Привет")]
    [InlineData("\u0085x")]
    public async Task A_bad_name_or_one_without_a_directory_is_400(string name)
    {
        var response = await CreateAsync(name);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(new MessageBody("Nieprawidłowa nazwa."), await response.Content.ReadFromJsonAsync<MessageBody>());
        Assert.Empty(Directory.GetFileSystemEntries(Api.ProjectsRoot));
    }

    [Fact]
    public async Task A_body_without_a_name_is_400()
    {
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PostAsJsonAsync("/api/workspaces", new { title = "Studia" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await Client.Http.PostAsync("/api/workspaces", new StringContent("Studia"))).StatusCode);
    }

    [Fact]
    public async Task A_name_whose_directory_is_taken_by_anything_is_409()
    {
        Directory.CreateDirectory(Api.ProjectPath("studia"));
        Api.WriteProjectFile("notatki", "a file");
        Api.Link("stare", Api.ProjectPath("nowhere"));

        foreach (var name in new[] { "Studia", "Notatki", "Stare" })
        {
            var response = await CreateAsync(name);
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            Assert.Equal(new MessageBody("Workspace już istnieje."), await response.Content.ReadFromJsonAsync<MessageBody>());
        }
        Assert.Equal("a file", File.ReadAllText(Api.ProjectPath("notatki")));
    }

    [Fact]
    public async Task Creating_needs_a_session_and_the_xsrf_token()
    {
        var stranger = new ApiClient(Api);
        Assert.Equal(HttpStatusCode.Unauthorized, (await stranger.Http.GetAsync("/api/workspaces")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await stranger.Http.PostAsJsonAsync("/api/workspaces", new { name = "Studia" })).StatusCode);

        Client.SendXsrf = false;

        Assert.Equal(HttpStatusCode.BadRequest, (await CreateAsync("Studia")).StatusCode);
        Assert.False(Directory.Exists(Api.ProjectPath("studia")));
    }

    private Task<HttpResponseMessage> CreateAsync(string name) => Client.Http.PostAsJsonAsync("/api/workspaces", new { name });

    private async Task<List<WorkspaceBody>> ListAsync()
    {
        var response = await Client.Http.GetAsync("/api/workspaces");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<List<WorkspaceBody>>())!;
    }
}
