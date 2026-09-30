// libc calls that System.IO does not offer: resolving every symlink of a path (realpath(3)) and the type of a file
// without following a final symlink (statx(2)), so FIFOs and devices are never opened. Linux only, like the deployment
// (docs/PLAN.md, "Backend decisions (stage 2)").
using System.Runtime.InteropServices;

namespace Claushh.Api.Files;

internal static class Libc
{
    public const int ENOENT = 2;
    public const int EACCES = 13;
    public const int ENOTDIR = 20;
    public const int ENAMETOOLONG = 36;
    public const int ELOOP = 40;

    public const int S_IFMT = 0xF000;
    public const int S_IFDIR = 0x4000;
    public const int S_IFREG = 0x8000;

    private const int AtFdCwd = -100;
    private const int AtSymlinkNoFollow = 0x100;
    private const uint StatxType = 0x1;
    // struct statx has the same layout on every architecture: 256 bytes, the 16-bit stx_mode at byte 28.
    private const int StatxSize = 256;
    private const int StatxModeOffset = 28;

    // The path with every symlink resolved, or null with errno (ENOENT, ENOTDIR, ELOOP, …).
    public static string? RealPath(string path, out int errno)
    {
        var resolved = RealPathNative(path, 0);
        if (resolved == 0)
        {
            errno = Marshal.GetLastPInvokeError();
            return null;
        }
        try
        {
            errno = 0;
            return Marshal.PtrToStringUTF8(resolved);
        }
        finally
        {
            Free(resolved);
        }
    }

    // The type bits (S_IFMT) of the path itself, a final symlink not followed; null when nothing is there.
    public static int? FileType(string path)
    {
        var buffer = new byte[StatxSize];
        return StatxNative(AtFdCwd, path, AtSymlinkNoFollow, StatxType, buffer) == 0
            ? BitConverter.ToUInt16(buffer, StatxModeOffset) & S_IFMT
            : null;
    }

    [DllImport("libc", EntryPoint = "realpath", SetLastError = true)]
    private static extern nint RealPathNative([MarshalAs(UnmanagedType.LPUTF8Str)] string path, nint resolved);

    [DllImport("libc", EntryPoint = "free")]
    private static extern void Free(nint pointer);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int StatxNative(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, byte[] buffer);
}
