using System;
using Dalamud.Configuration;
using Dalamud.Plugin;

namespace FFXIVBingo4All
{
    [Serializable]
    public sealed class Configuration : IPluginConfiguration
    {
        public int Version { get; set; } = 1;

        // Web settings
        public string ServerBaseUrl { get; set; } = "https://ffxivbingo4all.onrender.com";
        public string ClientBaseUrl { get; set; } = "https://ffxivbingo4all.onrender.com";
        public string AdminKey { get; set; } = string.Empty;
        public string RoomKey { get; set; } = string.Empty;

        [NonSerialized]
        private IDalamudPluginInterface? pluginInterface;

        public void Initialize(IDalamudPluginInterface pi)
        {
            pluginInterface = pi;
        }

        public void Save()
        {
            pluginInterface?.SavePluginConfig(this);
        }
    }

    [Serializable]
    public sealed class PlayerData
    {
        public string PlayerName { get; set; } = string.Empty;
        public int CardCount { get; set; } = 0;
        public string ShortCode { get; set; } = string.Empty;
    }
}
