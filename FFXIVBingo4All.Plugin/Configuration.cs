using System;
using System.Collections.Generic;
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
        public List<SkinPreset> SkinPresets { get; set; } = new();
        public string LastSkinPresetName { get; set; } = string.Empty;

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
    public sealed class SkinPreset
    {
        public string Name { get; set; } = string.Empty;
        public string BgColor { get; set; } = "121418FF";
        public string CardColor { get; set; } = "1C2126FF";
        public string HeaderColor { get; set; } = "29303AFF";
        public string TextColor { get; set; } = "E5EDF5FF";
        public string DaubColor { get; set; } = "33D17AFF";
        public string BallColor { get; set; } = "F5F5F5FF";
    }

    [Serializable]
    public sealed class PlayerData
    {
        public string PlayerName { get; set; } = string.Empty;
        public int CardCount { get; set; } = 0;
        public string ShortCode { get; set; } = string.Empty;
    }
}
