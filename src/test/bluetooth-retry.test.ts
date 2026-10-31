/* eslint-disable @typescript-eslint/no-floating-promises */
import { test, describe, beforeEach } from "node:test";
import { strictEqual, rejects } from "node:assert";
import { NiimbotBluetoothClient } from "..";
import { BleDefaultConfiguration } from "../client/bluetooth_impl";

const networkError = () => new DOMException("GATT Server is disconnected. Cannot retrieve services.", "NetworkError");

/** Fake Web Bluetooth device: service discovery fails with `errors` (in order), then succeeds. */
const createFakeDevice = (errors: Error[]) => {
  const device = new EventTarget() as EventTarget & { gatt: any; connectCalls: number };
  device.connectCalls = 0;

  const characteristic = { uuid: "char", properties: { notify: true, writeWithoutResponse: true } };
  const service = { uuid: "e7810a71-73ae-499d-8c15-faa9aef0c3f2", getCharacteristics: async () => [characteristic] };

  const server = {
    getPrimaryServices: async () => {
      const error = errors.shift();
      if (error !== undefined) {
        // like Chrome: the disconnect event fires, then the pending call rejects
        device.dispatchEvent(new Event("gattserverdisconnected"));
        throw error;
      }
      return [service];
    },
  };

  device.gatt = {
    connect: async () => {
      device.connectCalls++;
      return server;
    },
    disconnect: () => {},
  };

  return { device, characteristic };
};

describe("Bluetooth GATT connect retry", () => {
  let client: NiimbotBluetoothClient;
  let disconnectEvents: number;

  beforeEach(() => {
    (BleDefaultConfiguration as any).CONNECT_RETRY_DELAY_MS = 1;
    client = new NiimbotBluetoothClient();
    disconnectEvents = 0;
    client.on("disconnect", () => disconnectEvents++);
  });

  const connect = (device: any) => (client as any).connectGatt(device, device.gatt);

  test("connects on the first try without retrying", async () => {
    const { device, characteristic } = createFakeDevice([]);
    const result = await connect(device);
    strictEqual(result.channel, characteristic);
    strictEqual(device.connectCalls, 1);
    strictEqual(disconnectEvents, 0);
  });

  test("recovers after two dropped connections without reporting a disconnect", async () => {
    const { device, characteristic } = createFakeDevice([networkError(), networkError()]);
    const result = await connect(device);
    strictEqual(result.channel, characteristic);
    strictEqual(device.connectCalls, 3);
    strictEqual(disconnectEvents, 0);
  });

  test("reports a real disconnect after a successful (retried) connection", async () => {
    const { device } = createFakeDevice([networkError()]);
    await connect(device);
    device.dispatchEvent(new Event("gattserverdisconnected"));
    strictEqual(disconnectEvents, 1);
  });

  test("gives up after the configured number of attempts", async () => {
    const { device } = createFakeDevice([networkError(), networkError(), networkError(), networkError()]);
    await rejects(() => connect(device), { name: "NetworkError" });
    strictEqual(device.connectCalls, BleDefaultConfiguration.CONNECT_ATTEMPTS);
    strictEqual(disconnectEvents, 1);
  });

  test("does not retry errors other than NetworkError", async () => {
    const { device } = createFakeDevice([new Error("boom")]);
    await rejects(() => connect(device), { message: "boom" });
    strictEqual(device.connectCalls, 1);
  });
});
