using Microsoft.AspNetCore.Hosting;

namespace Claushh.Api.Tests;

public sealed class ProjectsRootTests(ApiFactory api)
{
    [Fact]
    public void The_api_refuses_to_start_without_an_existing_projects_directory()
    {
        using var broken = api.WithWebHostBuilder(builder =>
            builder.UseSetting("Projects:Root", Path.Join(api.ProjectsRoot, "missing")));

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient());

        Assert.Contains("Projects:Root", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void The_api_refuses_to_start_with_the_file_system_root_as_the_projects_directory()
    {
        using var broken = api.WithWebHostBuilder(builder => builder.UseSetting("Projects:Root", "/"));

        var error = Assert.ThrowsAny<Exception>(() => broken.CreateClient());

        Assert.Contains("Projects:Root", error.ToString(), StringComparison.Ordinal);
    }
}
