/*
 * Copyright 2022 gRPC authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { ChannelOptions, connectivityState, StatusObject } from ".";
import { Call } from "./call-stream";
import { ConnectivityState } from "./connectivity-state";
import { Status } from "./constants";
import { durationToMs, isDuration, msToDuration } from "./duration";
import { ChannelControlHelper, createChildChannelControlHelper, registerLoadBalancerType } from "./experimental";
import { BaseFilter, Filter, FilterFactory } from "./filter";
import { getFirstUsableConfig, LoadBalancer, LoadBalancingConfig, validateLoadBalancingConfig } from "./load-balancer";
import { ChildLoadBalancerHandler } from "./load-balancer-child-handler";
import { PickArgs, Picker, PickResult, PickResultType, QueuePicker, UnavailablePicker } from "./picker";
import { Subchannel } from "./subchannel";
import { SubchannelAddress, subchannelAddressToString } from "./subchannel-address";
import { BaseSubchannelWrapper, ConnectivityStateListener, SubchannelInterface } from "./subchannel-interface";


const TYPE_NAME = 'outlier_detection';

const OUTLIER_DETECTION_ENABLED = process.env.GRPC_EXPERIMENTAL_ENABLE_OUTLIER_DETECTION === 'true';

interface SuccessRateEjectionConfig {
  readonly stdev_factor: number;
  readonly enforcement_percentage: number;
  readonly minimum_hosts: number;
  readonly request_volume: number;
}

interface FailurePercentageEjectionConfig {
  readonly threshold: number;
  readonly enforcement_percentage: number;
  readonly minimum_hosts: number;
  readonly request_volume: number;
}

const defaultSuccessRateEjectionConfig: SuccessRateEjectionConfig = {
  stdev_factor: 1900,
  enforcement_percentage: 100,
  minimum_hosts: 5,
  request_volume: 100
};

const defaultFailurePercentageEjectionConfig: FailurePercentageEjectionConfig = {
  threshold: 85,
  enforcement_percentage: 100,
  minimum_hosts: 5,
  request_volume: 50
}

type TypeofValues = 'object' | 'boolean' | 'function' | 'number' | 'string' | 'undefined';

function validateFieldType(obj: any, fieldName: string, expectedType: TypeofValues, objectName?: string) {
  if (fieldName in obj && typeof obj[fieldName] !== expectedType) {
    const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
    throw new Error(`outlier detection config ${fullFieldName} parse error: expected ${expectedType}, got ${typeof obj[fieldName]}`);
  }
}

function validatePositiveDuration(obj: any, fieldName: string, objectName?: string) {
  const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
  if (fieldName in obj) {
    if (!isDuration(obj[fieldName])) {
      throw new Error(`outlier detection config ${fullFieldName} parse error: expected Duration, got ${typeof obj[fieldName]}`);
    }
    if (!(obj[fieldName].seconds >= 0 && obj[fieldName].seconds <= 315_576_000_000 && obj[fieldName].nanos >= 0 && obj[fieldName].nanos <= 999_999_999)) {
      throw new Error(`outlier detection config ${fullFieldName} parse error: values out of range for non-negative Duaration`);
    }
  }
}

function validatePercentage(obj: any, fieldName: string, objectName?: string) {
  const fullFieldName = objectName ? `${objectName}.${fieldName}` : fieldName;
  validateFieldType(obj, fieldName, 'number', objectName);
  if (fieldName in obj && !(obj[fieldName] >= 0 && obj[fieldName] <= 100)) {
    throw new Error(`outlier detection config ${fullFieldName} parse error: value out of range for percentage (0-100)`);
  }
}

export class OutlierDetectionLoadBalancingConfig implements LoadBalancingConfig {
  constructor(
    private readonly intervalMs: number,
    private readonly baseEjectionTimeMs: number,
    private readonly maxEjectionTimeMs: number,
    private readonly maxEjectionPercent: number,
    private readonly successRateEjection: SuccessRateEjectionConfig | null,
    private readonly failurePercentageEjection: FailurePercentageEjectionConfig | null,
    private readonly childPolicy: LoadBalancingConfig[]
  ) {}
  getLoadBalancerName(): string {
    return TYPE_NAME;
  }
  toJsonObject(): object {
    return {
      interval: msToDuration(this.intervalMs),
      base_ejection_time: msToDuration(this.baseEjectionTimeMs),
      max_ejection_time: msToDuration(this.maxEjectionTimeMs),
      max_ejection_percent: this.maxEjectionPercent,
      success_rate_ejection: this.successRateEjection,
      failure_percentage_ejection: this.failurePercentageEjection,
      child_policy: this.childPolicy.map(policy => policy.toJsonObject())
    };
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }
  getBaseEjectionTimeMs(): number {
    return this.baseEjectionTimeMs;
  }
  getMaxEjectionTimeMs(): number {
    return this.maxEjectionTimeMs;
  }
  getMaxEjectionPercent(): number {
    return this.maxEjectionPercent;
  }
  getSuccessRateEjectionConfig(): SuccessRateEjectionConfig | null {
    return this.successRateEjection;
  }
  getFailurePercentageEjectionConfig(): FailurePercentageEjectionConfig | null {
    return this.failurePercentageEjection;
  }
  getChildPolicy(): LoadBalancingConfig[] {
    return this.childPolicy;
  }
  static createFromJson(obj: any): OutlierDetectionLoadBalancingConfig {
    validatePositiveDuration(obj, 'interval');
    validatePositiveDuration(obj, 'base_ejection_time');
    validatePositiveDuration(obj, 'max_ejection_time');
    validatePercentage(obj, 'max_ejection_percent');
    if ('success_rate_ejection' in obj) {
      if (typeof obj.success_rate_ejection !== 'object') {
        throw new Error('outlier detection config success_rate_ejection must be an object');
      }
      validateFieldType(obj.success_rate_ejection, 'stdev_factor', 'number', 'success_rate_ejection');
      validatePercentage(obj.success_rate_ejection, 'enforcement_percentage', 'success_rate_ejection');
      validateFieldType(obj.success_rate_ejection, 'minimum_hosts', 'number', 'success_rate_ejection');
      validateFieldType(obj.success_rate_ejection, 'request_volume', 'number', 'success_rate_ejection');
    }
    if ('failure_percentage_ejection' in obj) {
      if (typeof obj.failure_percentage_ejection !== 'object') {
        throw new Error('outlier detection config failure_percentage_ejection must be an object');
      }
      validatePercentage(obj.failure_percentage_ejection, 'threshold', 'failure_percentage_ejection');
      validatePercentage(obj.failure_percentage_ejection, 'enforcement_percentage', 'failure_percentage_ejection');
      validateFieldType(obj.failure_percentage_ejection, 'minimum_hosts', 'number', 'failure_percentage_ejection');
      validateFieldType(obj.failure_percentage_ejection, 'request_volume', 'number', 'failure_percentage_ejection');
    }

    return new OutlierDetectionLoadBalancingConfig(
      obj.interval ? durationToMs(obj.interval) : 10_000,
      obj.base_ejection_time ? durationToMs(obj.base_ejection_time) : 30_000,
      obj.max_ejection_time ? durationToMs(obj.max_ejection_time) : 300_000,
      obj.max_ejection_percent ?? 10,
      obj.success_rate_ejection ? {...defaultSuccessRateEjectionConfig, ...obj.success_rate_ejection} : null,
      obj.failure_percentage_ejection ? {...defaultFailurePercentageEjectionConfig, ...obj.failure_percentage_ejection} : null,
      obj.child_policy.map(validateLoadBalancingConfig)
    );
  }
}

class OutlierDetectionSubchannelWrapper extends BaseSubchannelWrapper implements SubchannelInterface {
  private childSubchannelState: ConnectivityState = ConnectivityState.IDLE;
  private stateListeners: ConnectivityStateListener[] = [];
  private ejected: boolean = false;
  private refCount: number = 0;
  constructor(childSubchannel: SubchannelInterface, private mapEntry?: MapEntry) {
    super(childSubchannel);
    childSubchannel.addConnectivityStateListener((subchannel, previousState, newState) => {
      this.childSubchannelState = newState;
      if (!this.ejected) {
        for (const listener of this.stateListeners) {
          listener(this, previousState, newState);
        }
      }
    });
  }

  /**
   * Add a listener function to be called whenever the wrapper's
   * connectivity state changes.
   * @param listener
   */
  addConnectivityStateListener(listener: ConnectivityStateListener) {
    this.stateListeners.push(listener);
  }

  /**
   * Remove a listener previously added with `addConnectivityStateListener`
   * @param listener A reference to a function previously passed to
   *     `addConnectivityStateListener`
   */
  removeConnectivityStateListener(listener: ConnectivityStateListener) {
    const listenerIndex = this.stateListeners.indexOf(listener);
    if (listenerIndex > -1) {
      this.stateListeners.splice(listenerIndex, 1);
    }
  }

  ref() {
    this.child.ref();
    this.refCount += 1;
  }

  unref() {
    this.child.unref();
    this.refCount -= 1;
    if (this.refCount <= 0) {
      if (this.mapEntry) {
        const index = this.mapEntry.subchannelWrappers.indexOf(this);
        if (index >= 0) {
          this.mapEntry.subchannelWrappers.splice(index, 1);
        }
      }
    }
  }

  eject() {
    this.ejected = true;
    for (const listener of this.stateListeners) {
      listener(this, this.childSubchannelState, ConnectivityState.TRANSIENT_FAILURE);
    }
  }

  uneject() {
    this.ejected = false;
    for (const listener of this.stateListeners) {
      listener(this, ConnectivityState.TRANSIENT_FAILURE, this.childSubchannelState);
    }
  }

  getMapEntry(): MapEntry | undefined {
    return this.mapEntry;
  }

  getWrappedSubchannel(): SubchannelInterface {
    return this.child;
  }
}

interface CallCountBucket {
  success: number;
  failure: number;
}

function createEmptyBucket(): CallCountBucket {
  return {
    success: 0,
    failure: 0
  }
}

class CallCounter {
  private activeBucket: CallCountBucket = createEmptyBucket();
  private inactiveBucket: CallCountBucket = createEmptyBucket();
  addSuccess() {
    this.activeBucket.success += 1;
  }
  addFailure() {
    this.activeBucket.failure += 1;
  }
  switchBuckets() {
    this.inactiveBucket = this.activeBucket;
    this.activeBucket = createEmptyBucket();
  }
  getLastSuccesses() {
    return this.inactiveBucket.success;
  }
  getLastFailures() {
    return this.inactiveBucket.failure;
  }
}

interface MapEntry {
  counter: CallCounter;
  currentEjectionTimestamp: Date | null;
  ejectionTimeMultiplier: number;
  subchannelWrappers: OutlierDetectionSubchannelWrapper[];
}

class OutlierDetectionCounterFilter extends BaseFilter implements Filter {
  constructor(private callCounter: CallCounter) {
    super();
  }
  receiveTrailers(status: StatusObject): StatusObject {
    if (status.code === Status.OK) {
      this.callCounter.addSuccess();
    } else {
      this.callCounter.addFailure();
    }
    return status;
  }
}

class OutlierDetectionCounterFilterFactory implements FilterFactory<OutlierDetectionCounterFilter> {
  constructor(private callCounter: CallCounter) {}
  createFilter(callStream: Call): OutlierDetectionCounterFilter {
    return new OutlierDetectionCounterFilter(this.callCounter);
  }

}

class OutlierDetectionPicker implements Picker {
  constructor(private wrappedPicker: Picker) {}
  pick(pickArgs: PickArgs): PickResult {
    const wrappedPick = this.wrappedPicker.pick(pickArgs);
    if (wrappedPick.pickResultType === PickResultType.COMPLETE) {
      const subchannelWrapper = wrappedPick.subchannel as OutlierDetectionSubchannelWrapper;
      const mapEntry = subchannelWrapper.getMapEntry();
      if (mapEntry) {
        return {
          ...wrappedPick,
          subchannel: subchannelWrapper.getWrappedSubchannel(),
          extraFilterFactories: [...wrappedPick.extraFilterFactories, new OutlierDetectionCounterFilterFactory(mapEntry.counter)]
        };
      } else {
        return wrappedPick;
      }
    } else {
      return wrappedPick;
    }
  }

}

export class OutlierDetectionLoadBalancer implements LoadBalancer {
  private childBalancer: ChildLoadBalancerHandler;
  private addressMap: Map<string, MapEntry> = new Map<string, MapEntry>();
  private latestConfig: OutlierDetectionLoadBalancingConfig | null = null;
  private ejectionTimer: NodeJS.Timer;

  constructor(channelControlHelper: ChannelControlHelper) {
    this.childBalancer = new ChildLoadBalancerHandler(createChildChannelControlHelper(channelControlHelper, {
      createSubchannel: (subchannelAddress: SubchannelAddress, subchannelArgs: ChannelOptions) => {
        const originalSubchannel = channelControlHelper.createSubchannel(subchannelAddress, subchannelArgs);
        const mapEntry = this.addressMap.get(subchannelAddressToString(subchannelAddress));
        const subchannelWrapper = new OutlierDetectionSubchannelWrapper(originalSubchannel, mapEntry);
        mapEntry?.subchannelWrappers.push(subchannelWrapper);
        return subchannelWrapper;
      },
      updateState: (connectivityState: ConnectivityState, picker: Picker) => {
        if (connectivityState === ConnectivityState.READY) {
          channelControlHelper.updateState(connectivityState, new OutlierDetectionPicker(picker));
        } else {
          channelControlHelper.updateState(connectivityState, picker);
        }
      }
    }));
    this.ejectionTimer = setInterval(() => {}, 0);
    clearInterval(this.ejectionTimer);
  }

  private getCurrentEjectionPercent() {
    let ejectionCount = 0;
    for (const mapEntry of this.addressMap.values()) {
      if (mapEntry.currentEjectionTimestamp !== null) {
        ejectionCount += 1;
      }
    }
    return (ejectionCount * 100) / this.addressMap.size;
  }

  private runSuccessRateCheck(ejectionTimestamp: Date) {
    if (!this.latestConfig) {
      return;
    }
    const successRateConfig = this.latestConfig.getSuccessRateEjectionConfig();
    if (!successRateConfig) {
      return;
    }
    // Step 1
    const targetRequestVolume = successRateConfig.request_volume;
    let addresesWithTargetVolume = 0;
    const successRates: number[] = []
    for (const mapEntry of this.addressMap.values()) {
      const successes = mapEntry.counter.getLastSuccesses();
      const failures = mapEntry.counter.getLastFailures();
      if (successes + failures >= targetRequestVolume) {
        addresesWithTargetVolume += 1;
        successRates.push(successes/(successes + failures));
      }
    }
    if (addresesWithTargetVolume < successRateConfig.minimum_hosts) {
      return;
    }

    // Step 2
    const successRateMean = successRates.reduce((a, b) => a + b);
    let successRateVariance = 0;
    for (const rate of successRates) {
      const deviation = rate - successRateMean;
      successRateVariance += deviation * deviation;
    }
    const successRateStdev = Math.sqrt(successRateVariance);
    const ejectionThreshold = successRateMean - successRateStdev * (successRateConfig.stdev_factor / 1000);

    // Step 3
    for (const mapEntry of this.addressMap.values()) {
      // Step 3.i
      if (this.getCurrentEjectionPercent() > this.latestConfig.getMaxEjectionPercent()) {
        break;
      }
      // Step 3.ii
      const successes = mapEntry.counter.getLastSuccesses();
      const failures = mapEntry.counter.getLastFailures();
      if (successes + failures < targetRequestVolume) {
        continue;
      }
      // Step 3.iii
      const successRate = successes / (successes + failures);
      if (successRate < ejectionThreshold) {
        const randomNumber = Math.random() * 100;
        if (randomNumber < successRateConfig.enforcement_percentage) {
          this.eject(mapEntry, ejectionTimestamp);
        }
      }
    }
  }

  private runFailurePercentageCheck(ejectionTimestamp: Date) {
    if (!this.latestConfig) {
      return;
    }
    const failurePercentageConfig = this.latestConfig.getFailurePercentageEjectionConfig()
    if (!failurePercentageConfig) {
      return;
    }
    // Step 1
    if (this.addressMap.size < failurePercentageConfig.minimum_hosts) {
      return;
    }
    
    // Step 2
    for (const mapEntry of this.addressMap.values()) {
      // Step 2.i
      if (this.getCurrentEjectionPercent() > this.latestConfig.getMaxEjectionPercent()) {
        break;
      }
      // Step 2.ii
      const successes = mapEntry.counter.getLastSuccesses();
      const failures = mapEntry.counter.getLastFailures();
      if (successes + failures < failurePercentageConfig.request_volume) {
        continue;
      }
      // Step 2.iii
      const failurePercentage = (failures * 100) / (failures + successes);
      if (failurePercentage > failurePercentageConfig.threshold) {
        const randomNumber = Math.random() * 100;
        if (randomNumber < failurePercentageConfig.enforcement_percentage) {
          this.eject(mapEntry, ejectionTimestamp);
        }
      }
    }
  }

  private eject(mapEntry: MapEntry, ejectionTimestamp: Date) {
    mapEntry.currentEjectionTimestamp = new Date();
    mapEntry.ejectionTimeMultiplier += 1;
    for (const subchannelWrapper of mapEntry.subchannelWrappers) {
      subchannelWrapper.eject();
    }
  }

  private uneject(mapEntry: MapEntry) {
    mapEntry.currentEjectionTimestamp = null;
    for (const subchannelWrapper of mapEntry.subchannelWrappers) {
      subchannelWrapper.uneject();
    }
  }

  private runChecks() {
    const ejectionTimestamp = new Date();

    for (const mapEntry of this.addressMap.values()) {
      mapEntry.counter.switchBuckets();
    }

    if (!this.latestConfig) {
      return;
    }

    this.runSuccessRateCheck(ejectionTimestamp);
    this.runFailurePercentageCheck(ejectionTimestamp);

    for (const mapEntry of this.addressMap.values()) {
      if (mapEntry.currentEjectionTimestamp === null) {
        if (mapEntry.ejectionTimeMultiplier > 0) {
          mapEntry.ejectionTimeMultiplier -= 1;
        }
      } else {
        const baseEjectionTimeMs = this.latestConfig.getBaseEjectionTimeMs();
        const maxEjectionTimeMs = this.latestConfig.getMaxEjectionTimeMs();
        const returnTime = new Date(mapEntry.currentEjectionTimestamp.getTime());
        returnTime.setMilliseconds(returnTime.getMilliseconds() + Math.min(baseEjectionTimeMs * mapEntry.ejectionTimeMultiplier, Math.max(baseEjectionTimeMs, maxEjectionTimeMs)));
        if (returnTime < new Date()) {
          this.uneject(mapEntry);
        }
      }
    }
  }

  updateAddressList(addressList: SubchannelAddress[], lbConfig: LoadBalancingConfig, attributes: { [key: string]: unknown; }): void {
    if (!(lbConfig instanceof OutlierDetectionLoadBalancingConfig)) {
      return;
    }
    const subchannelAddresses = new Set<string>();
    for (const address of addressList) {
      subchannelAddresses.add(subchannelAddressToString(address));
    }
    for (const address of subchannelAddresses) {
      if (!this.addressMap.has(address)) {
        this.addressMap.set(address, {
          counter: new CallCounter(),
          currentEjectionTimestamp: null,
          ejectionTimeMultiplier: 0,
          subchannelWrappers: []
        });
      }
    }
    for (const key of this.addressMap.keys()) {
      if (!subchannelAddresses.has(key)) {
        this.addressMap.delete(key);
      }
    }
    const childPolicy: LoadBalancingConfig = getFirstUsableConfig(
      lbConfig.getChildPolicy(),
      true
    );
    this.childBalancer.updateAddressList(addressList, childPolicy, attributes);

    if (this.latestConfig === null || this.latestConfig.getIntervalMs() !== lbConfig.getIntervalMs()) {
      clearInterval(this.ejectionTimer);
      this.ejectionTimer = setInterval(() => this.runChecks(), lbConfig.getIntervalMs());
    }
    this.latestConfig = lbConfig;
  }
  exitIdle(): void {
    this.childBalancer.exitIdle();
  }
  resetBackoff(): void {
    this.childBalancer.resetBackoff();
  }
  destroy(): void {
    this.childBalancer.destroy();
  }
  getTypeName(): string {
    return TYPE_NAME;
  }
}

export function setup() {
  if (OUTLIER_DETECTION_ENABLED) {
    registerLoadBalancerType(TYPE_NAME, OutlierDetectionLoadBalancer, OutlierDetectionLoadBalancingConfig);
  }
}