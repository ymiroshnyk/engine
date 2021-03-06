/*
 Copyright (c) 2020 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
 not use Cocos Creator software for developing other software or tools that's
 used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 */

import { JSB } from 'internal:constants';
import { Frustum, Ray } from '../../geometry';
import { SurfaceTransform, ClearFlagBit, Device, Color, ClearFlags } from '../../gfx';
import {
    lerp, Mat4, Rect, toRadian, Vec3, IVec4Like,
} from '../../math';
import { CAMERA_DEFAULT_MASK } from '../../pipeline/define';
import { Node } from '../../scene-graph';
import { RenderScene } from './render-scene';
import { legacyCC } from '../../global-exports';
import { RenderWindow } from '../core/render-window';
import {
    CameraHandle, CameraPool, CameraView, FrustumHandle, FrustumPool, NULL_HANDLE, SceneHandle,
} from '../core/memory-pools';
import { recordFrustumToSharedMemory } from '../../geometry/frustum';
import { preTransforms } from '../../math/mat4';
import { director } from '../../director';

export enum CameraFOVAxis {
    VERTICAL,
    HORIZONTAL,
}

export enum CameraProjection {
    ORTHO,
    PERSPECTIVE,
}

export enum CameraAperture {
    F1_8,
    F2_0,
    F2_2,
    F2_5,
    F2_8,
    F3_2,
    F3_5,
    F4_0,
    F4_5,
    F5_0,
    F5_6,
    F6_3,
    F7_1,
    F8_0,
    F9_0,
    F10_0,
    F11_0,
    F13_0,
    F14_0,
    F16_0,
    F18_0,
    F20_0,
    F22_0,
}

export enum CameraISO {
    ISO100,
    ISO200,
    ISO400,
    ISO800,
}

export enum CameraShutter {
    D1,
    D2,
    D4,
    D8,
    D15,
    D30,
    D60,
    D125,
    D250,
    D500,
    D1000,
    D2000,
    D4000,
}

const FSTOPS: number[] = [1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.5, 4.0, 4.5, 5.0, 5.6, 6.3, 7.1, 8.0, 9.0, 10.0, 11.0, 13.0, 14.0, 16.0, 18.0, 20.0, 22.0];
const SHUTTERS: number[] = [1.0, 1.0 / 2.0, 1.0 / 4.0, 1.0 / 8.0, 1.0 / 15.0, 1.0 / 30.0, 1.0 / 60.0, 1.0 / 125.0,
    1.0 / 250.0, 1.0 / 500.0, 1.0 / 1000.0, 1.0 / 2000.0, 1.0 / 4000.0];
const ISOS: number[] = [100.0, 200.0, 400.0, 800.0];

export interface ICameraInfo {
    name: string;
    node: Node;
    projection: number;
    targetDisplay?: number;
    window?: RenderWindow | null;
    priority: number;
    pipeline?: string;
}

const v_a = new Vec3();
const v_b = new Vec3();
const _tempMat1 = new Mat4();

export const SKYBOX_FLAG = ClearFlagBit.STENCIL << 1;

const correctionMatrices: Mat4[] = [];

export class Camera {
    public isWindowSize = true;
    public screenScale: number;

    private _device: Device;
    private _scene: RenderScene | null = null;
    private _node: Node | null = null;
    private _name: string | null = null;
    private _enabled = false;
    private _proj: CameraProjection = -1;
    private _aspect: number;
    private _orthoHeight = 10.0;
    private _fovAxis = CameraFOVAxis.VERTICAL;
    private _fov: number = toRadian(45);
    private _nearClip = 1.0;
    private _farClip = 1000.0;
    private _clearColor = new Color(0.2, 0.2, 0.2, 1);
    private _viewport: Rect = new Rect(0, 0, 1, 1);
    private _curTransform = SurfaceTransform.IDENTITY;
    private _isProjDirty = true;
    private _matView: Mat4 = new Mat4();
    private _matViewInv: Mat4 | null = null;
    private _matProj: Mat4 = new Mat4();
    private _matProjInv: Mat4 = new Mat4();
    private _matViewProj: Mat4 = new Mat4();
    private _matViewProjInv: Mat4 = new Mat4();
    private _matProjOffscreen: Mat4 = new Mat4();
    private _matProjInvOffscreen: Mat4 = new Mat4();
    private _matViewProjOffscreen: Mat4 = new Mat4();
    private _matViewProjInvOffscreen: Mat4 = new Mat4();
    private _frustum: Frustum = new Frustum();
    private _forward: Vec3 = new Vec3();
    private _position: Vec3 = new Vec3();
    private _priority = 0;
    private _aperture: CameraAperture = CameraAperture.F16_0;
    private _apertureValue: number;
    private _shutter: CameraShutter = CameraShutter.D125;
    private _shutterValue = 0.0;
    private _iso: CameraISO = CameraISO.ISO100;
    private _isoValue = 0.0;
    private _ec = 0.0;
    private _poolHandle: CameraHandle = NULL_HANDLE;
    private _frustumHandle: FrustumHandle = NULL_HANDLE;
    private _window: RenderWindow | null = null;

    constructor (device: Device) {
        this._device = device;
        this._apertureValue = FSTOPS[this._aperture];
        this._shutterValue = SHUTTERS[this._shutter];
        this._isoValue = ISOS[this._iso];

        this._aspect = this.screenScale = 1;

        if (!correctionMatrices.length) {
            const ySign = device.capabilities.screenSpaceSignY;
            correctionMatrices[SurfaceTransform.IDENTITY] = new Mat4(1, 0, 0, 0, 0, ySign);
            correctionMatrices[SurfaceTransform.ROTATE_90] = new Mat4(0, 1, 0, 0, -ySign, 0);
            correctionMatrices[SurfaceTransform.ROTATE_180] = new Mat4(-1, 0, 0, 0, 0, -ySign);
            correctionMatrices[SurfaceTransform.ROTATE_270] = new Mat4(0, -1, 0, 0, ySign, 0);
        }
    }

    public initialize (info: ICameraInfo) {
        this._name = info.name;
        this._node = info.node;
        this._proj = info.projection;
        this._priority = info.priority || 0;

        this._aspect = this.screenScale = 1;
        const handle = this._poolHandle = CameraPool.alloc();
        CameraPool.set(handle, CameraView.WIDTH, 1);
        CameraPool.set(handle, CameraView.HEIGHT, 1);
        CameraPool.set(handle, CameraView.CLEAR_FLAGS, ClearFlagBit.NONE);
        CameraPool.set(handle, CameraView.CLEAR_DEPTH, 1.0);
        CameraPool.set(handle, CameraView.NODE, this._node.handle);
        CameraPool.set(handle, CameraView.VISIBILITY, CAMERA_DEFAULT_MASK);
        if (this._scene) CameraPool.set(handle, CameraView.SCENE, this._scene.handle);
        if (JSB) {
            this._frustumHandle = FrustumPool.alloc();
            CameraPool.set(handle, CameraView.FRUSTUM, this._frustumHandle);
        }

        this.updateExposure();
        this.changeTargetWindow(info.window);

        console.log(`Created Camera: ${this._name} ${CameraPool.get(handle,
            CameraView.WIDTH)}x${CameraPool.get(handle, CameraView.HEIGHT)}`);
    }

    public destroy () {
        if (this._window) {
            this._window.detachCamera(this);
        }
        this._name = null;
        if (this._poolHandle) {
            CameraPool.free(this._poolHandle);
            this._poolHandle = NULL_HANDLE;
            if (this._frustumHandle) {
                FrustumPool.free(this._frustumHandle);
                this._frustumHandle = NULL_HANDLE;
            }
        }
    }

    public attachToScene (scene: RenderScene) {
        this._scene = scene;
        this._enabled = true;
        CameraPool.set(this._poolHandle, CameraView.SCENE, scene.handle);
    }

    public detachFromScene () {
        this._scene = null;
        this._enabled = false;
        CameraPool.set(this._poolHandle, CameraView.SCENE, 0 as unknown as SceneHandle);
    }

    public resize (width: number, height: number) {
        const handle = this._poolHandle;
        CameraPool.set(handle, CameraView.WIDTH, width);
        CameraPool.set(handle, CameraView.HEIGHT, height);
        this._aspect = (width * this._viewport.width) / (height * this._viewport.height);
        this._isProjDirty = true;
    }

    public setFixedSize (width: number, height: number) {
        const handle = this._poolHandle;
        CameraPool.set(handle, CameraView.WIDTH, width);
        CameraPool.set(handle, CameraView.HEIGHT, height);
        this._aspect = (width * this._viewport.width) / (height * this._viewport.height);
        this.isWindowSize = false;
    }

    public update (forceUpdate = false) { // for lazy eval situations like the in-editor preview
        if (!this._node) return;

        let viewProjDirty = false;
        // view matrix
        if (this._node.hasChangedFlags || forceUpdate) {
            Mat4.invert(this._matView, this._node.worldMatrix);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW, this._matView);

            this._forward.x = -this._matView.m02;
            this._forward.y = -this._matView.m06;
            this._forward.z = -this._matView.m10;
            this._node.getWorldPosition(this._position);
            CameraPool.setVec3(this._poolHandle, CameraView.POSITION, this._position);
            CameraPool.setVec3(this._poolHandle, CameraView.FORWARD, this._forward);
            viewProjDirty = true;
        }

        // projection matrix
        const orientation = this._device.surfaceTransform;
        if (this._isProjDirty || this._curTransform !== orientation) {
            this._curTransform = orientation;
            const projectionSignY = this._device.capabilities.screenSpaceSignY;
            if (this._proj === CameraProjection.PERSPECTIVE) {
                Mat4.perspective(this._matProj, this._fov, this._aspect, this._nearClip, this._farClip,
                    this._fovAxis === CameraFOVAxis.VERTICAL, this._device.capabilities.clipSpaceMinZ, projectionSignY, orientation);

                Mat4.perspective(this._matProjOffscreen, this._fov, this._aspect, this._nearClip, this._farClip,
                    this._fovAxis === CameraFOVAxis.VERTICAL,
                    this._device.capabilities.clipSpaceMinZ,
                    projectionSignY * this._device.capabilities.UVSpaceSignY,
                    SurfaceTransform.IDENTITY);
            } else {
                const x = this._orthoHeight * this._aspect; // aspect is already oriented
                const y = this._orthoHeight;
                Mat4.ortho(this._matProj, -x, x, -y, y, this._nearClip, this._farClip,
                    this._device.capabilities.clipSpaceMinZ, projectionSignY, orientation);

                Mat4.ortho(this._matProjOffscreen, -x, x, -y, y, this._nearClip, this._farClip,
                    this._device.capabilities.clipSpaceMinZ, projectionSignY * this._device.capabilities.UVSpaceSignY, SurfaceTransform.IDENTITY);
            }
            Mat4.invert(this._matProjInv, this._matProj);
            Mat4.invert(this._matProjInvOffscreen, this._matProjOffscreen);

            CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ, this._matProj);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ_INV, this._matProjInv);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ_OFFSCREEN, this._matProjOffscreen);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ_INV_OFFSCREEN, this._matProjInvOffscreen);
            viewProjDirty = true;
            this._isProjDirty = false;
        }

        // view-projection
        if (viewProjDirty) {
            Mat4.multiply(this._matViewProj, this._matProj, this._matView);
            Mat4.multiply(this._matViewProjOffscreen, this._matProjOffscreen, this._matView);
            Mat4.invert(this._matViewProjInv, this._matViewProj);
            Mat4.invert(this._matViewProjInvOffscreen, this._matViewProjOffscreen);
            this._frustum.update(this._matViewProj, this._matViewProjInv);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ, this._matViewProj);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ_INV, this._matViewProjInv);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ_OFFSCREEN, this._matViewProjOffscreen);
            CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ_INV_OFFSCREEN, this._matViewProjInvOffscreen);
            recordFrustumToSharedMemory(this._frustumHandle, this._frustum);
        }
    }

    set node (val: Node) {
        this._node = val;
    }

    get node () {
        return this._node!;
    }

    set enabled (val) {
        this._enabled = val;
    }

    get enabled () {
        return this._enabled;
    }

    set orthoHeight (val) {
        this._orthoHeight = val;
        this._isProjDirty = true;
    }

    get orthoHeight () {
        return this._orthoHeight;
    }

    set projectionType (val) {
        this._proj = val;
        this._isProjDirty = true;
    }

    get projectionType () {
        return this._proj;
    }

    set fovAxis (axis) {
        this._fovAxis = axis;
        this._isProjDirty = true;
    }

    get fovAxis () {
        return this._fovAxis;
    }

    set fov (fov) {
        this._fov = fov;
        this._isProjDirty = true;
    }

    get fov () {
        return this._fov;
    }

    set nearClip (nearClip) {
        this._nearClip = nearClip;
        this._isProjDirty = true;
    }

    get nearClip () {
        return this._nearClip;
    }

    set farClip (farClip) {
        this._farClip = farClip;
        this._isProjDirty = true;
    }

    get farClip () {
        return this._farClip;
    }

    set clearColor (val) {
        this._clearColor.x = val.x;
        this._clearColor.y = val.y;
        this._clearColor.z = val.z;
        this._clearColor.w = val.w;
        CameraPool.setVec4(this._poolHandle, CameraView.CLEAR_COLOR, val);
    }

    get clearColor () {
        return this._clearColor as IVec4Like;
    }

    get viewport () {
        return this._viewport;
    }

    set viewport (val) {
        const { x, width, height } = val;
        const y = this._device.capabilities.screenSpaceSignY < 0 ? 1 - val.y - height : val.y;

        switch (this._device.surfaceTransform) {
        case SurfaceTransform.ROTATE_90:
            this._viewport.x = 1 - y - height;
            this._viewport.y = x;
            this._viewport.width = height;
            this._viewport.height = width;
            break;
        case SurfaceTransform.ROTATE_180:
            this._viewport.x = 1 - x - width;
            this._viewport.y = 1 - y - height;
            this._viewport.width = width;
            this._viewport.height = height;
            break;
        case SurfaceTransform.ROTATE_270:
            this._viewport.x = y;
            this._viewport.y = 1 - x - width;
            this._viewport.width = height;
            this._viewport.height = width;
            break;
        case SurfaceTransform.IDENTITY:
            this._viewport.x = x;
            this._viewport.y = y;
            this._viewport.width = width;
            this._viewport.height = height;
            break;
        default:
        }

        CameraPool.setVec4(this._poolHandle, CameraView.VIEW_PORT, this._viewport);
        this.resize(this.width, this.height);
    }

    get scene () {
        return this._scene;
    }

    get name () {
        return this._name;
    }

    get width () {
        return CameraPool.get(this._poolHandle, CameraView.WIDTH);
    }

    get height () {
        return CameraPool.get(this._poolHandle, CameraView.HEIGHT);
    }

    get aspect () {
        return this._aspect;
    }

    set matView (val) {
        this._matView = val;
        CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW, this._matView);
    }

    get matView () {
        return this._matView;
    }

    set matViewInv (val: Mat4 | null) {
        this._matViewInv = val;
    }

    get matViewInv () {
        return this._matViewInv || this._node!.worldMatrix;
    }

    set matProj (val) {
        this._matProj = val;
        CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ, this._matProj);
    }

    get matProj () {
        return this._matProj;
    }

    set matProjInv (val) {
        this._matProjInv = val;
        CameraPool.setMat4(this._poolHandle, CameraView.MAT_PROJ_INV, this._matProjInv);
    }

    get matProjInv () {
        return this._matProjInv;
    }

    set matViewProj (val) {
        this._matViewProj = val;
        CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ, this._matViewProj);
    }

    get matViewProj () {
        return this._matViewProj;
    }

    set matViewProjInv (val) {
        this._matViewProjInv = val;
        CameraPool.setMat4(this._poolHandle, CameraView.MAT_VIEW_PROJ_INV, this._matViewProjInv);
    }

    get matViewProjInv () {
        return this._matViewProjInv;
    }

    get matProjOffscreen () {
        return this._matProjOffscreen;
    }

    get matProjInvOffscreen () {
        return this._matProjInvOffscreen;
    }

    get matViewProjOffscreen () {
        return this._matViewProjOffscreen;
    }

    get matViewProjInvOffscreen () {
        return this._matViewProjInvOffscreen;
    }

    set frustum (val) {
        this._frustum = val;
        recordFrustumToSharedMemory(this._frustumHandle, val);
    }

    get frustum () {
        return this._frustum;
    }

    set window (val) {
        this._window = val;
        if (val) CameraPool.set(this._poolHandle, CameraView.WINDOW, val.handle);
    }

    get window () {
        return this._window;
    }

    set forward (val) {
        this._forward = val;
        CameraPool.setVec3(this._poolHandle, CameraView.FORWARD, this._forward);
    }

    get forward () {
        return this._forward;
    }

    set position (val) {
        this._position = val;
        CameraPool.setVec3(this._poolHandle, CameraView.POSITION, this._position);
    }

    get position () {
        return this._position;
    }

    set visibility (vis: number) {
        CameraPool.set(this._poolHandle, CameraView.VISIBILITY, vis);
    }
    get visibility (): number {
        return CameraPool.get(this._poolHandle, CameraView.VISIBILITY);
    }

    get priority (): number {
        return this._priority;
    }

    set priority (val: number) {
        this._priority = val;
    }

    set aperture (val: CameraAperture) {
        this._aperture = val;
        this._apertureValue = FSTOPS[this._aperture];
        this.updateExposure();
    }

    get aperture (): CameraAperture {
        return this._aperture;
    }

    get apertureValue (): number {
        return this._apertureValue;
    }

    set shutter (val: CameraShutter) {
        this._shutter = val;
        this._shutterValue = SHUTTERS[this._shutter];
        this.updateExposure();
    }

    get shutter (): CameraShutter {
        return this._shutter;
    }

    get shutterValue (): number {
        return this._shutterValue;
    }

    set iso (val: CameraISO) {
        this._iso = val;
        this._isoValue = ISOS[this._iso];
        this.updateExposure();
    }

    get iso (): CameraISO {
        return this._iso;
    }

    get isoValue (): number {
        return this._isoValue;
    }

    set ec (val: number) {
        this._ec = val;
    }

    get ec (): number {
        return this._ec;
    }

    get exposure (): number {
        return CameraPool.get(this._poolHandle, CameraView.EXPOSURE);
    }

    get clearFlag () : ClearFlags {
        return CameraPool.get(this._poolHandle, CameraView.CLEAR_FLAGS);
    }

    set clearFlag (flag: ClearFlags) {
        CameraPool.set(this._poolHandle, CameraView.CLEAR_FLAGS, flag);
    }

    get clearDepth () : number {
        return CameraPool.get(this._poolHandle, CameraView.CLEAR_DEPTH);
    }

    set clearDepth (depth: number) {
        CameraPool.set(this._poolHandle, CameraView.CLEAR_DEPTH, depth);
    }

    get clearStencil () : number {
        return CameraPool.get(this._poolHandle, CameraView.CLEAR_STENCIL);
    }

    set clearStencil (stencil: number) {
        CameraPool.set(this._poolHandle, CameraView.CLEAR_STENCIL, stencil);
    }

    get handle () : CameraHandle {
        return this._poolHandle;
    }

    public changeTargetWindow (window: RenderWindow | null = null) {
        if (this._window) {
            this._window.detachCamera(this);
        }
        const win = window || legacyCC.director.root.mainWindow;
        if (win) {
            win.attachCamera(this);
            this.resize(win.width, win.height);
            this._window = win;
            CameraPool.set(this._poolHandle, CameraView.WINDOW, win.handle);
        }
    }

    public detachCamera () {
        if (this._window) {
            this._window.detachCamera(this);
        }
    }

    /**
     * transform a screen position (in oriented space) to a world space ray
     */
    public screenPointToRay (out: Ray, x: number, y: number): Ray {
        if (!this._node) return null!;

        const handle = this._poolHandle;
        const width = CameraPool.get(handle, CameraView.WIDTH);
        const height = CameraPool.get(handle, CameraView.HEIGHT);
        const cx = this._viewport.x * width;
        const cy = this._viewport.y * height;
        const cw = this._viewport.width * width;
        const ch = this._viewport.height * height;
        const isProj = this._proj === CameraProjection.PERSPECTIVE;
        const ySign = this._device.capabilities.screenSpaceSignY;
        const preTransform = preTransforms[this._curTransform];

        Vec3.set(v_a, (x - cx) / cw * 2 - 1, (y - cy) / ch * 2 - 1, isProj ? 1 : -1);

        const { x: ox, y: oy } = v_a;
        v_a.x = ox * preTransform[0] + oy * preTransform[2] * ySign;
        v_a.y = ox * preTransform[1] + oy * preTransform[3] * ySign;

        Vec3.transformMat4(isProj ? v_a : out.o, v_a, this._matViewProjInv);

        if (isProj) {
            // camera origin
            this._node.getWorldPosition(v_b);
            Ray.fromPoints(out, v_b, v_a);
        } else {
            Vec3.transformQuat(out.d, Vec3.FORWARD, this._node.worldRotation);
        }

        return out;
    }

    /**
     * transform a screen position (in oriented space) to world space
     */
    public screenToWorld (out: Vec3, screenPos: Vec3): Vec3 {
        const handle = this._poolHandle;
        const width = CameraPool.get(handle, CameraView.WIDTH);
        const height = CameraPool.get(handle, CameraView.HEIGHT);
        const cx = this._viewport.x * width;
        const cy = this._viewport.y * height;
        const cw = this._viewport.width * width;
        const ch = this._viewport.height * height;
        const ySign = this._device.capabilities.screenSpaceSignY;
        const preTransform = preTransforms[this._curTransform];

        if (this._proj === CameraProjection.PERSPECTIVE) {
            // calculate screen pos in far clip plane
            Vec3.set(out,
                (screenPos.x - cx) / cw * 2 - 1,
                (screenPos.y - cy) / ch * 2 - 1,
                1.0);

            // transform to world
            const { x, y } = out;
            out.x = x * preTransform[0] + y * preTransform[2] * ySign;
            out.y = x * preTransform[1] + y * preTransform[3] * ySign;
            Vec3.transformMat4(out, out, this._matViewProjInv);

            // lerp to depth z
            if (this._node) { this._node.getWorldPosition(v_a); }

            Vec3.lerp(out, v_a, out, lerp(this._nearClip / this._farClip, 1, screenPos.z));
        } else {
            Vec3.set(out,
                (screenPos.x - cx) / cw * 2 - 1,
                (screenPos.y - cy) / ch * 2 - 1,
                screenPos.z * 2 - 1);

            // transform to world
            const { x, y } = out;
            out.x = x * preTransform[0] + y * preTransform[2] * ySign;
            out.y = x * preTransform[1] + y * preTransform[3] * ySign;
            Vec3.transformMat4(out, out, this._matViewProjInv);
        }

        return out;
    }

    /**
     * transform a world space position to screen space
     */
    public worldToScreen (out: Vec3, worldPos: Vec3): Vec3 {
        const handle = this._poolHandle;
        const width = CameraPool.get(handle, CameraView.WIDTH);
        const height = CameraPool.get(handle, CameraView.HEIGHT);
        const cx = this._viewport.x * width;
        const cy = this._viewport.y * height;
        const cw = this._viewport.width * width;
        const ch = this._viewport.height * height;
        const ySign = this._device.capabilities.screenSpaceSignY;
        const preTransform = preTransforms[this._curTransform];

        Vec3.transformMat4(out, worldPos, this._matViewProj);

        const { x, y } = out;
        out.x = x * preTransform[0] + y * preTransform[2] * ySign;
        out.y = x * preTransform[1] + y * preTransform[3] * ySign;

        out.x = cx + (out.x + 1) * 0.5 * cw;
        out.y = cy + (out.y + 1) * 0.5 * ch;
        out.z = out.z * 0.5 + 0.5;

        return out;
    }

    /**
     * transform a world space matrix to screen space
     * @param {Mat4} out the resulting vector
     * @param {Mat4} worldMatrix the world space matrix to be transformed
     * @param {number} width framebuffer width
     * @param {number} height framebuffer height
     * @returns {Mat4} the resulting vector
     */
    public worldMatrixToScreen (out: Mat4, worldMatrix: Mat4, width: number, height: number) {
        Mat4.multiply(out, this._matViewProj, worldMatrix);
        Mat4.multiply(out, correctionMatrices[this._curTransform], out);

        const halfWidth = width / 2;
        const halfHeight = height / 2;
        Mat4.identity(_tempMat1);
        Mat4.transform(_tempMat1, _tempMat1, Vec3.set(v_a, halfWidth, halfHeight, 0));
        Mat4.scale(_tempMat1, _tempMat1, Vec3.set(v_a, halfWidth, halfHeight, 1));

        Mat4.multiply(out, _tempMat1, out);

        return out;
    }

    private updateExposure () {
        const ev100 = Math.log2((this._apertureValue * this._apertureValue) / this._shutterValue * 100.0 / this._isoValue);
        CameraPool.set(this._poolHandle, CameraView.EXPOSURE, 0.833333 / (2.0 ** ev100));
    }
}
