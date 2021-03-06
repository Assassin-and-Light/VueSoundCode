/* @flow */

export default class VNode {
  // 节点的内容
  tag: string | void; // 标签
  data: VNodeData | void; // 被绑定在虚拟dom上面的监听的事件、attr、slot、staticStyle样式
  children: ?Array<VNode>; // 虚拟DOM的子节点
  text: string | void; //节点文本
  elm: Node | void; // 节点真实元素
  ns: string | void; // 节点命名空间
  context: Component | void; // 渲染这个组件的上下文
  key: string | number | void; // key
  componentOptions: VNodeComponentOptions | void; // 组件的属性列表对象
  componentInstance: Component | void; // component instance
  parent: VNode | void; // 组件占位符Vnode，当前将要转化为真实DOM的父Vnode

  // 状态
  raw: boolean; // 是否包含原始HTML (极限服务器渲染)
  isStatic: boolean; // 是否是静态节点
  isRootInsert: boolean; // 是否作为根节点插入
  isComment: boolean; // 是否为注释节点
  isCloned: boolean; //是否为克隆节点
  isOnce: boolean; // 是否为渲染一次的节点?
  asyncFactory: Function | void; //异步工厂函数
  asyncMeta: Object | void; // 异步meta
  isAsyncPlaceholder: boolean; // 是否为异步站位
  ssrContext: Object | void;
  fnContext: Component | void; // real context vm for functional nodes
  fnOptions: ?ComponentOptions; // for SSR caching
  devtoolsMeta: ?Object; // used to store functional render context for devtools
  fnScopeId: ?string; // functional scope id support

  constructor(
    tag?: string,
    data?: VNodeData,
    children?: ?Array<VNode>,
    text?: string,
    elm?: Node,
    context?: Component,
    componentOptions?: VNodeComponentOptions,
    asyncFactory?: Function
  ) {
    this.tag = tag              /*当前节点的标签名*/
    this.data = data            /*当前节点对应的对象，包含了具体的一些数据信息，是一个VNodeData类型，可以参考VNodeData类型中的数据信息*/
    this.children = children    /*当前节点的子节点，是一个数组*/
    this.text = text            /*当前节点的文本*/
    this.elm = elm              /*当前虚拟节点对应的真实dom节点*/
    this.ns = undefined         /*当前节点的名字空间*/
    this.context = context      /*当前组件节点对应的Vue实例*/
    this.fnContext = undefined  /*函数式组件对应的Vue实例*/
    this.fnOptions = undefined
    this.fnScopeId = undefined
    this.key = data && data.key  /*节点的key属性，被当作节点的标志，用以优化*/
    this.componentOptions = componentOptions   /*组件的option选项*/
    this.componentInstance = undefined       /*当前节点对应的组件的实例*/
    this.parent = undefined           /*当前节点的父节点*/
    this.raw = false         /*简而言之就是是否为原生HTML或只是普通文本，innerHTML的时候为true，textContent的时候为false*/
    this.isStatic = false         /*静态节点标志*/
    this.isRootInsert = true      /*是否作为跟节点插入*/
    this.isComment = false             /*是否为注释节点*/
    this.isCloned = false           /*是否为克隆节点*/
    this.isOnce = false                /*是否有v-once指令*/
    this.asyncFactory = asyncFactory
    this.asyncMeta = undefined
    this.isAsyncPlaceholder = false
  }

  // DEPRECATED: alias for componentInstance for backwards compat.
  /* istanbul ignore next */
  get child(): Component | void {
    return this.componentInstance
  }
}

export const createEmptyVNode = (text: string = '') => {
  const node = new VNode()
  node.text = text
  node.isComment = true
  return node
}

export function createTextVNode(val: string | number) {
  return new VNode(undefined, undefined, undefined, String(val))
}

// optimized shallow clone
// used for static nodes and slot nodes because they may be reused across
// multiple renders, cloning them avoids errors when DOM manipulations rely
// on their elm reference.
export function cloneVNode(vnode: VNode): VNode {
  const cloned = new VNode(
    vnode.tag,
    vnode.data,
    // #7975
    // clone children array to avoid mutating original in case of cloning
    // a child.
    vnode.children && vnode.children.slice(),
    vnode.text,
    vnode.elm,
    vnode.context,
    vnode.componentOptions,
    vnode.asyncFactory
  )
  cloned.ns = vnode.ns
  cloned.isStatic = vnode.isStatic
  cloned.key = vnode.key
  cloned.isComment = vnode.isComment
  cloned.fnContext = vnode.fnContext
  cloned.fnOptions = vnode.fnOptions
  cloned.fnScopeId = vnode.fnScopeId
  cloned.asyncMeta = vnode.asyncMeta
  cloned.isCloned = true
  return cloned
}
