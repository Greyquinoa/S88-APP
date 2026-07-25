import React, { useState, useEffect } from "react";
import SymbolTableGrid from "./SymbolTableGrid.tsx";
import { getSlotChannels } from "./api.js";

export default function SymbolTableModal({ importId, stations, onClose }) {
  const [symbolData, setSymbolData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSymbolTable();
  }, [importId, stations]);

  async function loadSymbolTable() {
    if (!importId || !stations || stations.length === 0) {
      setSymbolData([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const allChannels = [];

      // Batch all API calls in parallel for better performance
      const slotPromises = [];
      for (const station of stations) {
        const stationName = station.name || `Station ${station.address}`;
        if (!station.slots || station.slots.length === 0) continue;

        for (const slot of station.slots) {
          slotPromises.push(
            getSlotChannels(importId, station.address, slot.slot)
              .then(channels => {
                const slotChannels = [];
                for (const channel of channels) {
                  // Filter to only channels with assigned signal names
                  if (!channel.tag) continue;

                  const address = `${station.address}:${slot.slot}:${channel.channel}`;
                  const dataType = mapSignalType(channel.signal_type);

                  slotChannels.push({
                    station: stationName,
                    address,
                    signalName: channel.tag,
                    dataType,
                    description: channel.description || "—",
                  });
                }
                return slotChannels;
              })
              .catch(err => {
                console.error(
                  `Failed to load channels for station ${station.address} slot ${slot.slot}:`,
                  err
                );
                return [];
              })
          );
        }
      }

      // Wait for all API calls and combine results
      const results = await Promise.all(slotPromises);
      for (const slotChannels of results) {
        allChannels.push(...slotChannels);
      }

      // Add row numbers after combining
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
  maxHeight: "90vh",
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
