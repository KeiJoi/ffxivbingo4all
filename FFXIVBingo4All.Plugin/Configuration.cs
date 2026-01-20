using System;
using System.Collections.Generic;
using System.Numerics;
using Dalamud.Configuration;
using Dalamud.Plugin;

namespace FFXIVBingo4All
{
    [Serializable]
    public sealed class Configuration : IPluginConfiguration
    {
        public int Version { get; set; } = 1;

        // Game state
        public string CurrentRoomCode { get; set; } = string.Empty;
        public List<int> CalledNumbers { get; set; } = new();

        // Financial settings
        public int CostPerCard { get; set; } = 0;
        public int StartingPot { get; set; } = 0;
        public float PrizePercentage { get; set; } = 0.0f;
        public string CustomHeaderLetters { get; set; } = "BINGO";
        public string VenueName { get; set; } = "FFXIV Bingo";
        public bool BingoActive { get; set; } = true;
        public string GameType { get; set; } = "Single Line";

        // Web settings
        public string ServerBaseUrl { get; set; } = "http://localhost:3000";
        public string ClientBaseUrl { get; set; } = "http://localhost:3000";
        public string AdminKey { get; set; } = string.Empty;

        // Visual settings
        public Vector4 BgColor { get; set; } = new(0.07f, 0.08f, 0.09f, 1.0f);
        public Vector4 CardColor { get; set; } = new(0.11f, 0.13f, 0.15f, 1.0f);
        public Vector4 HeaderColor { get; set; } = new(0.16f, 0.19f, 0.23f, 1.0f);
        public Vector4 TextColor { get; set; } = new(0.90f, 0.93f, 0.96f, 1.0f);
        public Vector4 DaubColor { get; set; } = new(0.20f, 0.82f, 0.48f, 1.0f);
        public Vector4 BallColor { get; set; } = new(0.96f, 0.96f, 0.96f, 1.0f);

        // Anti-cheat / player ledger
        public Dictionary<string, PlayerData> IssuedCards { get; set; } = new();

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
