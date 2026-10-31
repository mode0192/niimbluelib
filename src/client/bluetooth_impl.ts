import { ConnectEvent, DisconnectEvent, RawPacketSentEvent } from "../events";
import { ConnectionInfo, NiimbotAbstractClient, NiimbotClientType } from ".";
import { ConnectResult } from "../packets";
import { Utils } from "../utils";
import { modelsLibrary } from "../printer_models";

const getAllModelFirstLetters = (): string[] => [...new Set(modelsLibrary.map((m) => m.model[0]))];

/**
 * @category Client
 */
export interface NiimbotBluetoothClientConnectOptions {
  /**
   * Allows using authorized device without device picker dialog.
   * "Use the new permissions backend for Web Bluetooth" at chrome://flags must be enabled to use `navigator.bluetooth.gedDevices()`
   *
   * Example:
   *
   * ```
   * const authorized = await navigator.bluetooth.getDevices();
   * const authorizedDevice = authorized.find(d => d.name.includes("B1"));
   * await client.connect({ authorizedDevice });
   * ```
   */
  authorizedDevice?: BluetoothDevice
}

/**
 * @category Client
 */
export class BleDefaultConfiguration {
  public static readonly SERVICES: string[] = ["e7810a71-73ae-499d-8c15-faa9aef0c3f2"];
  public static readonly NAME_FILTERS: BluetoothLEScanFilter[] = [
    ...getAllModelFirstLetters().map((l) => ({ namePrefix: l })),
  ];
  /** How many times to try opening the GATT connection before failing. */
  public static readonly CONNECT_ATTEMPTS: number = 3;
  /** Pause between GATT connection attempts. */
  public static readonly CONNECT_RETRY_DELAY_MS: number = 500;
}

/**
 * Uses [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
 *
 * @category Client
 */
export class NiimbotBluetoothClient extends NiimbotAbstractClient {
  private gattServer?: BluetoothRemoteGATTServer = undefined;
  private channel?: BluetoothRemoteGATTCharacteristic = undefined;
  private serviceUuidFilter: string[] = BleDefaultConfiguration.SERVICES;

  public getServiceUuidFilter(): string[] {
    return this.serviceUuidFilter;
  }

  public setServiceUuidFilter(ids: string[]): void {
    this.serviceUuidFilter = ids;
  }

  public async connect(options?: NiimbotBluetoothClientConnectOptions): Promise<ConnectionInfo> {
    await this.disconnect();

    let device: BluetoothDevice;

    if (options?.authorizedDevice !== undefined) {
      device = options?.authorizedDevice;
    } else {
      const options: RequestDeviceOptions = {
        filters: [
          ...BleDefaultConfiguration.NAME_FILTERS,
          { services: this.serviceUuidFilter ?? BleDefaultConfiguration.SERVICES },
        ],
      };

      device = await navigator.bluetooth.requestDevice(options);
    }


    if (device.gatt === undefined) {
      throw new Error("Device has no Bluetooth Generic Attribute Profile");
    }

    const { gattServer, channel } = await this.connectGatt(device, device.gatt);

    if (channel === undefined) {
      gattServer.disconnect();
      throw new Error("Suitable device characteristic not found");
    }

    console.log(`Found suitable characteristic ${channel.uuid}`);

    channel.addEventListener("characteristicvaluechanged", (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic;
      this.processRawPacket(target.value!);
    });

    await channel.startNotifications();

    this.gattServer = gattServer;
    this.channel = channel;

    await this.negotiateAndGetPrinterInfo(() => this.disconnect());

    const result: ConnectionInfo = {
      deviceName: device.name,
      result: this.printerInfo.connectResult ?? ConnectResult.FirmwareErrors,
    };

    this.emit("connect", new ConnectEvent(result));

    return result;
  }

  /**
   * Connect to the GATT server and look up the data characteristic.
   *
   * Web Bluetooth sometimes drops the link right after `gatt.connect()` succeeds, which surfaces as
   * `NetworkError: GATT Server is disconnected. Cannot retrieve services.` A new attempt on the same
   * device usually works, so retry a few times before giving up.
   */
  private async connectGatt(
    device: BluetoothDevice,
    gatt: BluetoothRemoteGATTServer
  ): Promise<{ gattServer: BluetoothRemoteGATTServer; channel: BluetoothRemoteGATTCharacteristic | undefined }> {
    for (let attempt = 1; ; attempt++) {
      const lastAttempt: boolean = attempt >= BleDefaultConfiguration.CONNECT_ATTEMPTS;
      let established: boolean = false;

      const disconnectListener = () => {
        device.removeEventListener("gattserverdisconnected", disconnectListener);

        // A drop while still connecting is handled by the retry below, it is not a user-visible disconnect.
        if (established || lastAttempt) {
          this.gattServer = undefined;
          this.channel = undefined;
          this.emit("disconnect", new DisconnectEvent());
        }
      };

      device.addEventListener("gattserverdisconnected", disconnectListener);

      try {
        const gattServer: BluetoothRemoteGATTServer = await gatt.connect();
        const channel = await this.findSuitableBluetoothCharacteristic(gattServer);
        established = true;
        return { gattServer, channel };
      } catch (e) {
        const retryable: boolean = e instanceof DOMException && e.name === "NetworkError";

        if (!retryable || lastAttempt) {
          throw e;
        }

        console.warn(`GATT connection failed (attempt ${attempt}/${BleDefaultConfiguration.CONNECT_ATTEMPTS}), retrying`, e);
        device.removeEventListener("gattserverdisconnected", disconnectListener);
        gatt.disconnect();
        await Utils.sleep(BleDefaultConfiguration.CONNECT_RETRY_DELAY_MS);
      }
    }
  }

  private async findSuitableBluetoothCharacteristic(
    gattServer: BluetoothRemoteGATTServer
  ): Promise<BluetoothRemoteGATTCharacteristic | undefined> {
    const services: BluetoothRemoteGATTService[] = await gattServer.getPrimaryServices();

    for (const service of services) {
      if (service.uuid.length < 5) {
        continue;
      }

      const characteristics: BluetoothRemoteGATTCharacteristic[] = await service.getCharacteristics();

      for (const c of characteristics) {
        if (c.properties.notify && c.properties.writeWithoutResponse) {
          return c;
        }
      }
    }
    return undefined;
  }

  public isConnected(): boolean {
    return this.gattServer !== undefined && this.channel !== undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async disconnect() {
    this.stopHeartbeat();
    this.gattServer?.disconnect();
    this.gattServer = undefined;
    this.channel = undefined;
  }

  public async sendRaw(data: Uint8Array, force?: boolean) {
    const send = async () => {
      if (this.channel === undefined) {
        throw new Error("Channel is closed");
      }
      await Utils.sleep(this.packetIntervalMs);
      await this.channel.writeValueWithoutResponse(data.buffer as ArrayBuffer);
      this.emit("rawpacketsent", new RawPacketSentEvent(data));
    };

    if (force) {
      await send();
    } else {
      await this.mutex.runExclusive(send);
    }
  }

  public getType(): NiimbotClientType {
    return "bluetooth";
  }
}
