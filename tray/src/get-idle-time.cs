using System;
using System.Runtime.InteropServices;

public class IdleTimeFinder {
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
    
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    
    public static void Main() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        if (GetLastInputInfo(ref info)) {
            uint idleTime = ((uint)Environment.TickCount - info.dwTime) / 1000;
            Console.WriteLine(idleTime);
        } else {
            Console.WriteLine(0);
        }
    }
}
