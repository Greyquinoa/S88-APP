import React, { useState, useEffect } from "react";
import SymbolTableGrid from "./SymbolTableGrid.tsx";
import { getAllSlotChannels } from "./api.js";

export default function SymbolTableModal({ importId, stations, onClose }) {
  const [symbolData, setSymbolData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSymbolTable();
  }, [importId, stations]);

  function calculateMnemonic(signalType, channelIndex) {
    // Format matches PCS7 CFG: "{identifier} {offset}.{bit}" or "{identifier} {byteOfs}.0" for words
    const chIdx = Number(channelIndex) || 0;

    // Digital modules: bit-packed (DI, DO) → byte_offset.bit_position (8 bits per byte)
    // I 0.0, I 0.1, I 0.2, ..., I 1.0 (at channel 8)
    if (signalType === 'DI' || signalType === 'MIXED') {
      const byteOfs = Math.floor(chIdx / 8);
      const bitPos = chIdx % 8;
      return `I ${byteOfs}.${bitPos}`;
    }
    if (signalType === 'DO') {
      const byteOfs = Math.floor(chIdx / 8);
      const bitPos = chIdx % 8;
      return `Q ${byteOfs}.${bitPos}`;
    }

    // Analog modules: word-based (AI, AO) → byte offset (2 bytes per channel)
    // IW 0.0, IW 2.0, IW 4.0, etc.
    if (signalType === 'AI') {
      const byteOfs = chIdx * 2;
      return `IW ${byteOfs}.0`;
    }
    if (signalType === 'AO') {
      const byteOfs = chIdx * 2;
      return `QW ${byteOfs}.0`;
    }

    // PROFIBUS PA: bit format
    if (signalType === 'PA') {
      const byteOfs = Math.floor(chIdx / 8);
      const bitPos = chIdx % 8;
      return `I ${byteOfs}.${bitPos}`;
    }

    // Infrastructure: bit format
    if (signalType === 'INFRA') {
      const byteOfs = Math.floor(chIdx / 8);
      const bitPos = chIdx % 8;
      return `I ${byteOfs}.${bitPos}`;
    }

    return '—';
  }

  async function loadSymbolTable() {
    if (!importId || !stations || stations.length === 0) {
      setSymbolData([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Single batch API call instead of looping through 100+ slots
      const stationData = await getAllSlotChannels(importId);
      const allChannels = [];

      for (const station of stationData) {
        for (const slot of station.slots) {
          for (const channel of slot.channels) {
            // Filter to only channels with assigned signal names
            if (!channel.tag) continue;

            const deviceSlotChannel = `${station.stationAddress}:${slot.slot}:${channel.channel}`;
            const mnemonic = calculateMnemonic(channel.signal_type, channel.channel);
            const dataType = mapSignalType(channel.signal_type);

            allChannels.push({
              station: station.stationName,
              deviceSlotChannel,
              address: mnemonic,
              signalName: channel.tag,
              dataType,
              description: channel.description || "—",
            });
          }
        }
      }

      // Add row numbers
      allChannels.forEach((ch, i) => {
        ch.rowNum = i + 1;
      });

      setSymbolData(allChannels);
    } catch (err) {
      console.error("Failed to load symbol table:", err);
      setSymbolData([]);
    } finally {
      setLoading(false);
    }
  }

  function mapSignalType(signalType) {
    if (!signalType) return "—";
    const typeMap = {
      DI: "DI",
      DO: "DO",
      AI: "AI",
      AO: "AO",
      PA: "PA",
      INFRA: "INFRA",
      MIXED: "MIXED",
    };
    return typeMap[signalType] || signalType.toUpperCase();
  }

  return (
    <div style={modalOverlayStyle}>
      <div style={modalContentStyle}>
        <div style={modalHeaderStyle}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1a1a1a" }}>
            Symbol Table
          </h2>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 24,
              color: "#999",
              padding: "0 8px",
              display: "flex",
              alignItems: "center",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <SymbolTableGrid data={symbolData} loading={loading} />
        </div>

        <div style={modalFooterStyle}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px",
              borderRadius: 6,
              border: "1px solid #ccd",
              background: "#f0f4ff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
              whiteSpace: "nowrap",
              color: "#1a1a1a",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const modalOverlayStyle = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalContentStyle = {
  display: "flex",
  flexDirection: "column",
  width: "98%",
  maxWidth: 1800,
  height: "90vh",
  background: "#ffffff",
  borderRadius: 12,
  boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
  overflow: "hidden",
};

const modalHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "20px 24px",
  background: "#f9f9fb",
  borderBottom: "1px solid #e0e0e4",
  flexShrink: 0,
};

const modalFooterStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 12,
  padding: "16px 24px",
  background: "#f9f9fb",
  borderTop: "1px solid #e0e0e4",
  flexShrink: 0,
};
