/* @flow */

import he from "he";
import { parseHTML } from "./html-parser";
import { parseText } from "./text-parser";
import { parseFilters } from "./filter-parser";
import { genAssignmentCode } from "../directives/model";
import { extend, cached, no, camelize, hyphenate } from "shared/util";
import { isIE, isEdge, isServerRendering } from "core/util/env";

import {
  addProp,
  addAttr,
  baseWarn,
  addHandler,
  addDirective,
  getBindingAttr,
  getAndRemoveAttr,
  getRawBindingAttr,
  pluckModuleFunction,
  getAndRemoveAttrByRegex
} from "../helpers";

export const onRE = /^@|^v-on:/;
export const dirRE = process.env.VBIND_PROP_SHORTHAND
  ? /^v-|^@|^:|^\.|^#/
  : /^v-|^@|^:|^#/;
export const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/;
export const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/;
const stripParensRE = /^\(|\)$/g;
const dynamicArgRE = /^\[.*\]$/;

const argRE = /:(.*)$/;
export const bindRE = /^:|^\.|^v-bind:/;
const propBindRE = /^\./;
const modifierRE = /\.[^.\]]+(?=[^\]]*$)/g;

const slotRE = /^v-slot(:|$)|^#/;

const lineBreakRE = /[\r\n]/;
const whitespaceRE = /\s+/g;

const invalidAttributeRE = /[\s"'<>\/=]/;

const decodeHTMLCached = cached(he.decode);

export const emptySlotScopeToken = `_empty_`;

// configurable state
export let warn: any;
let delimiters;
let transforms;
let preTransforms;
let postTransforms;
let platformIsPreTag;
let platformMustUseProp;
let platformGetTagNamespace;
let maybeComponent;

// 生成AST树，组建父子关系
export function createASTElement(
  tag: string,
  attrs: Array<ASTAttr>,
  parent: ASTElement | void
): ASTElement {
  return {
    type: 1,
    tag,
    attrsList: attrs,
    attrsMap: makeAttrsMap(attrs),
    rawAttrsMap: {},
    parent,
    children: []
  };
}

// 将 HTML 字符串转换为 AST
export function parse(
  template: string,
  options: CompilerOptions
): ASTElement | void {
  warn = options.warn || baseWarn;

  platformIsPreTag = options.isPreTag || no; //是平台预留标签
  platformMustUseProp = options.mustUseProp || no; //平台必须使用的属性
  platformGetTagNamespace = options.getTagNamespace || no; //平台的命名空间
  const isReservedTag = options.isReservedTag || no; //是保留标签
  maybeComponent = (el: ASTElement) => !!el.component || !isReservedTag(el.tag);

  transforms = pluckModuleFunction(options.modules, "transformNode"); //转换
  preTransforms = pluckModuleFunction(options.modules, "preTransformNode"); //预转换
  postTransforms = pluckModuleFunction(options.modules, "postTransformNode"); //转换后

  delimiters = options.delimiters;

  const stack = [];
  const preserveWhitespace = options.preserveWhitespace !== false; //保留空白
  const whitespaceOption = options.whitespace; //空格选项
  let root;
  let currentParent; //当前的父，第一次是undefined
  let inVPre = false; //是否在v-pre下（这个节点是否需要编译）
  let inPre = false;
  let warned = false;

  //* 警告函数
  function warnOnce(msg, range) {
    if (!warned) {
      warned = true;
      warn(msg, range);
    }
  }

  function closeElement(element) {
    trimEndingWhitespace(element);
    if (!inVPre && !element.processed) {
      element = processElement(element, options);
    }

    // 树管理
    if (!stack.length && element !== root) {
      // 允许根元素带有v-if, v-else-if和v-else
      if (root.if && (element.elseif || element.else)) {
        if (process.env.NODE_ENV !== "production") {
          checkRootConstraints(element);
        }
        addIfCondition(root, {
          exp: element.elseif,
          block: element
        });
      } else if (process.env.NODE_ENV !== "production") {
        warnOnce(
          `Component template should contain exactly one root element. ` +
            `If you are using v-if on multiple elements, ` +
            `use v-else-if to chain them instead.`,
          { start: element.start }
        );
      }
    }

    // 存在父添加父子关系
    if (currentParent && !element.forbidden) {
      if (element.elseif || element.else) {
        processIfConditions(element, currentParent);
      } else {
        if (element.slotScope) {
          // scoped slot
          // 将它保存在子列表中，这样v-else(-if)条件就可以找到它作为prev节点
          const name = element.slotTarget || '"default"';
          (currentParent.scopedSlots || (currentParent.scopedSlots = {}))[
            name
          ] = element;
        }
        currentParent.children.push(element);
        element.parent = currentParent;
      }
    }

    // 最终children清理过滤出作用域的插槽
    element.children = element.children.filter(c => !(c: any).slotScope);
    // 再次删除尾随空格节点
    trimEndingWhitespace(element);

    // 还原之前的状态
    if (element.pre) {
      inVPre = false;
    }
    // 还原之前的状态
    if (platformIsPreTag(element.tag)) {
      inPre = false;
    }
    // 执行 post-transforms
    for (let i = 0; i < postTransforms.length; i++) {
      postTransforms[i](element, options);
    }
  }

  // 删除空白节点
  function trimEndingWhitespace(el) {
    if (!inPre) {
      let lastNode;
      while (
        (lastNode = el.children[el.children.length - 1]) &&
        lastNode.type === 3 &&
        lastNode.text === " "
      ) {
        el.children.pop();
      }
    }
  }

  // 检查根约束
  function checkRootConstraints(el) {
    if (el.tag === "slot" || el.tag === "template") {
      warnOnce(
        `Cannot use <${el.tag}> as component root element because it may ` +
          "contain multiple nodes.",
        { start: el.start }
      );
    }
    if (el.attrsMap.hasOwnProperty("v-for")) {
      warnOnce(
        "Cannot use v-for on stateful component root element because " +
          "it renders multiple elements.",
        el.rawAttrsMap["v-for"]
      );
    }
  }

  parseHTML(template, {
    warn,
    expectHTML: options.expectHTML,
    isUnaryTag: options.isUnaryTag,
    canBeLeftOpenTag: options.canBeLeftOpenTag,
    shouldDecodeNewlines: options.shouldDecodeNewlines,
    shouldDecodeNewlinesForHref: options.shouldDecodeNewlinesForHref,
    shouldKeepComment: options.comments,
    outputSourceRange: options.outputSourceRange,

    start(tag, attrs, unary, start, end) {
      // 检查命名空间。如果有父 ns，则继承父 ns
      const ns =
        (currentParent && currentParent.ns) || platformGetTagNamespace(tag);
      if (ns) {
        element.ns = ns;
      }

      // 处理 IE svg bug
      if (isIE && ns === "svg") {
        attrs = guardIESVGBug(attrs);
      }

      // 创建一个ast元素，组建父子关系
      let element: ASTElement = createASTElement(tag, attrs, currentParent);

      if (process.env.NODE_ENV !== "production") {
        // 对象里拼接为rawAttrsMap对象，是属性的key,value格式
        if (options.outputSourceRange) {
          element.start = start;
          element.end = end;
          element.rawAttrsMap = element.attrsList.reduce((cumulated, attr) => {
            cumulated[attr.name] = attr;
            return cumulated;
          }, {});
        }

        // 检测是否是无效的属性
        attrs.forEach(attr => {
          if (invalidAttributeRE.test(attr.name)) {
            warn(
              `Invalid dynamic argument expression: attribute names cannot contain ` +
                `spaces, quotes, <, >, / or =.`,
              {
                start: attr.start + attr.name.indexOf(`[`),
                end: attr.start + attr.name.length
              }
            );
          }
        });
      }

      // 不是服务端渲染，并且是禁止的标签类型就，报警告
      if (isForbiddenTag(element) && !isServerRendering()) {
        element.forbidden = true;
        process.env.NODE_ENV !== "production" &&
          warn(
            "Templates should only be responsible for mapping the state to the " +
              "UI. Avoid placing tags with side-effects in your templates, such as " +
              `<${tag}>` +
              ", as they will not be parsed.",
            { start: element.start }
          );
      }

      // 预转换
      for (let i = 0; i < preTransforms.length; i++) {
        element = preTransforms[i](element, options) || element;
      }

      // 检测添加属性v-pre
      if (!inVPre) {
        processPre(element);
        if (element.pre) {
          inVPre = true;
        }
      }
      if (platformIsPreTag(element.tag)) {
        inPre = true;
      }
      if (inVPre) {
        processRawAttrs(element);
      }
      // 没有加工过的元素加工指令结构
      else if (!element.processed) {
        processFor(element);
        processIf(element);
        processOnce(element);
      }

      // 检查元素的规范
      if (!root) {
        root = element;
        if (process.env.NODE_ENV !== "production") {
          checkRootConstraints(root);
        }
      }

      // 如果不是一元标签就加入栈队列,是一元标签就添加父子关系
      if (!unary) {
        currentParent = element;
        stack.push(element);
      } else {
        closeElement(element);
      }
    },

    end(tag, start, end) {
      const element = stack[stack.length - 1];
      // pop stack
      stack.length -= 1;
      currentParent = stack[stack.length - 1];
      if (process.env.NODE_ENV !== "production" && options.outputSourceRange) {
        element.end = end;
      }
      closeElement(element);
    },

    chars(text: string, start: number, end: number) {
      if (!currentParent) {
        if (process.env.NODE_ENV !== "production") {
          if (text === template) {
            warnOnce(
              "Component template requires a root element, rather than just text.",
              { start }
            );
          } else if ((text = text.trim())) {
            warnOnce(`text "${text}" outside root element will be ignored.`, {
              start
            });
          }
        }
        return;
      }
      // IE textarea placeholder 问题
      /* istanbul ignore if */
      if (
        isIE &&
        currentParent.tag === "textarea" &&
        currentParent.attrsMap.placeholder === text
      ) {
        return;
      }
      const children = currentParent.children;
      if (inPre || text.trim()) {
        text = isTextTag(currentParent) ? text : decodeHTMLCached(text);
      } else if (!children.length) {
        // remove the whitespace-only node right after an opening tag
        text = "";
      } else if (whitespaceOption) {
        if (whitespaceOption === "condense") {
          // 在压缩模式下，如果空格节点包含换行符，则删除空格节点，否则压缩为单个空格
          text = lineBreakRE.test(text) ? "" : " ";
        } else {
          text = " ";
        }
      } else {
        text = preserveWhitespace ? " " : "";
      }

      // 创建文本子节点，一种是有表达式的，type 为 2，一种是纯文本，type 为 3
      if (text) {
        if (!inPre && whitespaceOption === "condense") {
          // 将连续的空格压缩成单个空格
          text = text.replace(whitespaceRE, " ");
        }
        let res;
        let child: ?ASTNode;
        // 如果有分隔符，有文本内容就位表达式的文本
        if (!inVPre && text !== " " && (res = parseText(text, delimiters))) {
          child = {
            type: 2,
            expression: res.expression,
            tokens: res.tokens,
            text
          };
        }
        // 如果有文本或者文本不存在子内容，就是一个纯文本
        else if (
          text !== " " ||
          !children.length ||
          children[children.length - 1].text !== " "
        ) {
          child = {
            type: 3,
            text
          };
        }

        if (child) {
          if (
            process.env.NODE_ENV !== "production" &&
            options.outputSourceRange
          ) {
            child.start = start;
            child.end = end;
          }
          children.push(child);
        }
      }
    },

    comment(text: string, start, end) {
      // adding anything as a sibling to the root node is forbidden
      // comments should still be allowed, but ignored
      if (currentParent) {
        const child: ASTText = {
          type: 3,
          text,
          isComment: true
        };
        if (
          process.env.NODE_ENV !== "production" &&
          options.outputSourceRange
        ) {
          child.start = start;
          child.end = end;
        }
        currentParent.children.push(child);
      }
    }
  });

  return root;
}

function processPre(el) {
  if (getAndRemoveAttr(el, "v-pre") != null) {
    el.pre = true;
  }
}

function processRawAttrs(el) {
  const list = el.attrsList;
  const len = list.length;
  if (len) {
    const attrs: Array<ASTAttr> = (el.attrs = new Array(len));
    for (let i = 0; i < len; i++) {
      attrs[i] = {
        name: list[i].name,
        value: JSON.stringify(list[i].value)
      };
      if (list[i].start != null) {
        attrs[i].start = list[i].start;
        attrs[i].end = list[i].end;
      }
    }
  } else if (!el.pre) {
    // non root node in pre blocks with no attributes
    el.plain = true;
  }
}

// 处理元素节点过程
export function processElement(element: ASTElement, options: CompilerOptions) {
  processKey(element);

  // determine whether this is a plain element after
  // removing structural attributes
  element.plain =
    !element.key && !element.scopedSlots && !element.attrsList.length;

  processRef(element);
  processSlotContent(element);
  processSlotOutlet(element);
  processComponent(element);
  for (let i = 0; i < transforms.length; i++) {
    element = transforms[i](element, options) || element;
  }
  processAttrs(element);
  return element;
}

function processKey(el) {
  const exp = getBindingAttr(el, "key");
  if (exp) {
    if (process.env.NODE_ENV !== "production") {
      if (el.tag === "template") {
        warn(
          `<template> cannot be keyed. Place the key on real elements instead.`,
          getRawBindingAttr(el, "key")
        );
      }
      if (el.for) {
        const iterator = el.iterator2 || el.iterator1;
        const parent = el.parent;
        if (
          iterator &&
          iterator === exp &&
          parent &&
          parent.tag === "transition-group"
        ) {
          warn(
            `Do not use v-for index as key on <transition-group> children, ` +
              `this is the same as not using keys.`,
            getRawBindingAttr(el, "key"),
            true /* tip */
          );
        }
      }
    }
    el.key = exp;
  }
}

function processRef(el) {
  const ref = getBindingAttr(el, "ref");
  if (ref) {
    el.ref = ref;
    el.refInFor = checkInFor(el);
  }
}

export function processFor(el: ASTElement) {
  let exp;
  if ((exp = getAndRemoveAttr(el, "v-for"))) {
    const res = parseFor(exp);
    if (res) {
      extend(el, res);
    } else if (process.env.NODE_ENV !== "production") {
      warn(`Invalid v-for expression: ${exp}`, el.rawAttrsMap["v-for"]);
    }
  }
}

type ForParseResult = {
  for: string,
  alias: string,
  iterator1?: string,
  iterator2?: string
};

export function parseFor(exp: string): ?ForParseResult {
  const inMatch = exp.match(forAliasRE);
  if (!inMatch) return;
  const res = {};
  res.for = inMatch[2].trim();
  const alias = inMatch[1].trim().replace(stripParensRE, "");
  const iteratorMatch = alias.match(forIteratorRE);
  if (iteratorMatch) {
    res.alias = alias.replace(forIteratorRE, "").trim();
    res.iterator1 = iteratorMatch[1].trim();
    if (iteratorMatch[2]) {
      res.iterator2 = iteratorMatch[2].trim();
    }
  } else {
    res.alias = alias;
  }
  return res;
}

function processIf(el) {
  const exp = getAndRemoveAttr(el, "v-if");
  if (exp) {
    el.if = exp;
    addIfCondition(el, {
      exp: exp,
      block: el
    });
  } else {
    if (getAndRemoveAttr(el, "v-else") != null) {
      el.else = true;
    }
    const elseif = getAndRemoveAttr(el, "v-else-if");
    if (elseif) {
      el.elseif = elseif;
    }
  }
}

function processIfConditions(el, parent) {
  const prev = findPrevElement(parent.children);
  if (prev && prev.if) {
    addIfCondition(prev, {
      exp: el.elseif,
      block: el
    });
  } else if (process.env.NODE_ENV !== "production") {
    warn(
      `v-${el.elseif ? 'else-if="' + el.elseif + '"' : "else"} ` +
        `used on element <${el.tag}> without corresponding v-if.`,
      el.rawAttrsMap[el.elseif ? "v-else-if" : "v-else"]
    );
  }
}

function findPrevElement(children: Array<any>): ASTElement | void {
  let i = children.length;
  while (i--) {
    if (children[i].type === 1) {
      return children[i];
    } else {
      if (process.env.NODE_ENV !== "production" && children[i].text !== " ") {
        warn(
          `text "${children[i].text.trim()}" between v-if and v-else(-if) ` +
            `will be ignored.`,
          children[i]
        );
      }
      children.pop();
    }
  }
}

export function addIfCondition(el: ASTElement, condition: ASTIfCondition) {
  if (!el.ifConditions) {
    el.ifConditions = [];
  }
  el.ifConditions.push(condition);
}

function processOnce(el) {
  const once = getAndRemoveAttr(el, "v-once");
  if (once != null) {
    el.once = true;
  }
}

// handle content being passed to a component as slot,
// e.g. <template slot="xxx">, <div slot-scope="xxx">
function processSlotContent(el) {
  let slotScope;
  if (el.tag === "template") {
    slotScope = getAndRemoveAttr(el, "scope");
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== "production" && slotScope) {
      warn(
        `the "scope" attribute for scoped slots have been deprecated and ` +
          `replaced by "slot-scope" since 2.5. The new "slot-scope" attribute ` +
          `can also be used on plain elements in addition to <template> to ` +
          `denote scoped slots.`,
        el.rawAttrsMap["scope"],
        true
      );
    }
    el.slotScope = slotScope || getAndRemoveAttr(el, "slot-scope");
  } else if ((slotScope = getAndRemoveAttr(el, "slot-scope"))) {
    /* istanbul ignore if */
    if (process.env.NODE_ENV !== "production" && el.attrsMap["v-for"]) {
      warn(
        `Ambiguous combined usage of slot-scope and v-for on <${el.tag}> ` +
          `(v-for takes higher priority). Use a wrapper <template> for the ` +
          `scoped slot to make it clearer.`,
        el.rawAttrsMap["slot-scope"],
        true
      );
    }
    el.slotScope = slotScope;
  }

  // slot="xxx"
  const slotTarget = getBindingAttr(el, "slot");
  if (slotTarget) {
    el.slotTarget = slotTarget === '""' ? '"default"' : slotTarget;
    el.slotTargetDynamic = !!(
      el.attrsMap[":slot"] || el.attrsMap["v-bind:slot"]
    );
    // preserve slot as an attribute for native shadow DOM compat
    // only for non-scoped slots.
    if (el.tag !== "template" && !el.slotScope) {
      addAttr(el, "slot", slotTarget, getRawBindingAttr(el, "slot"));
    }
  }

  // 2.6 v-slot syntax
  if (process.env.NEW_SLOT_SYNTAX) {
    if (el.tag === "template") {
      // v-slot on <template>
      const slotBinding = getAndRemoveAttrByRegex(el, slotRE);
      if (slotBinding) {
        if (process.env.NODE_ENV !== "production") {
          if (el.slotTarget || el.slotScope) {
            warn(`Unexpected mixed usage of different slot syntaxes.`, el);
          }
          if (el.parent && !maybeComponent(el.parent)) {
            warn(
              `<template v-slot> can only appear at the root level inside ` +
                `the receiving component`,
              el
            );
          }
        }
        const { name, dynamic } = getSlotName(slotBinding);
        el.slotTarget = name;
        el.slotTargetDynamic = dynamic;
        el.slotScope = slotBinding.value || emptySlotScopeToken; // force it into a scoped slot for perf
      }
    } else {
      // v-slot on component, denotes default slot
      const slotBinding = getAndRemoveAttrByRegex(el, slotRE);
      if (slotBinding) {
        if (process.env.NODE_ENV !== "production") {
          if (!maybeComponent(el)) {
            warn(
              `v-slot can only be used on components or <template>.`,
              slotBinding
            );
          }
          if (el.slotScope || el.slotTarget) {
            warn(`Unexpected mixed usage of different slot syntaxes.`, el);
          }
          if (el.scopedSlots) {
            warn(
              `To avoid scope ambiguity, the default slot should also use ` +
                `<template> syntax when there are other named slots.`,
              slotBinding
            );
          }
        }
        // add the component's children to its default slot
        const slots = el.scopedSlots || (el.scopedSlots = {});
        const { name, dynamic } = getSlotName(slotBinding);
        const slotContainer = (slots[name] = createASTElement(
          "template",
          [],
          el
        ));
        slotContainer.slotTarget = name;
        slotContainer.slotTargetDynamic = dynamic;
        slotContainer.children = el.children.filter((c: any) => {
          if (!c.slotScope) {
            c.parent = slotContainer;
            return true;
          }
        });
        slotContainer.slotScope = slotBinding.value || emptySlotScopeToken;
        // remove children as they are returned from scopedSlots now
        el.children = [];
        // mark el non-plain so data gets generated
        el.plain = false;
      }
    }
  }
}

function getSlotName(binding) {
  let name = binding.name.replace(slotRE, "");
  if (!name) {
    if (binding.name[0] !== "#") {
      name = "default";
    } else if (process.env.NODE_ENV !== "production") {
      warn(`v-slot shorthand syntax requires a slot name.`, binding);
    }
  }
  return dynamicArgRE.test(name)
    ? // dynamic [name]
      { name: name.slice(1, -1), dynamic: true }
    : // static name
      { name: `"${name}"`, dynamic: false };
}

// handle <slot/> outlets
function processSlotOutlet(el) {
  if (el.tag === "slot") {
    el.slotName = getBindingAttr(el, "name");
    if (process.env.NODE_ENV !== "production" && el.key) {
      warn(
        `\`key\` does not work on <slot> because slots are abstract outlets ` +
          `and can possibly expand into multiple elements. ` +
          `Use the key on a wrapping element instead.`,
        getRawBindingAttr(el, "key")
      );
    }
  }
}

function processComponent(el) {
  let binding;
  if ((binding = getBindingAttr(el, "is"))) {
    el.component = binding;
  }
  if (getAndRemoveAttr(el, "inline-template") != null) {
    el.inlineTemplate = true;
  }
}

// export const onRE = /^@|^v-on:/
// export const dirRE = /^v-|^@|^:/
// export const bindRE = /^:|^v-bind:/
function processAttrs(el) {
  const list = el.attrsList;
  let i, l, name, rawName, value, modifiers, syncGen, isDynamic;
  for (i = 0, l = list.length; i < l; i++) {
    name = rawName = list[i].name;
    value = list[i].value;

    // 如果是绑定属性类型的修饰
    if (dirRE.test(name)) {
      // mark element as dynamic
      el.hasBindings = true;
      // 找到修饰符
      modifiers = parseModifiers(name.replace(dirRE, ""));
      // 支持.prop修饰符的.foo简写语法
      if (process.env.VBIND_PROP_SHORTHAND && propBindRE.test(name)) {
        (modifiers || (modifiers = {})).prop = true;
        name = `.` + name.slice(1).replace(modifierRE, "");
      } else if (modifiers) {
        name = name.replace(modifierRE, "");
      }

      // 如果是绑定的属性
      if (bindRE.test(name)) {
        name = name.replace(bindRE, "");
        value = parseFilters(value);
        isDynamic = dynamicArgRE.test(name);
        if (isDynamic) {
          name = name.slice(1, -1);
        }

        if (
          process.env.NODE_ENV !== "production" &&
          value.trim().length === 0
        ) {
          warn(
            `The value for a v-bind expression cannot be empty. Found in "v-bind:${name}"`
          );
        }

        if (modifiers) {
          if (modifiers.prop && !isDynamic) {
            name = camelize(name);
            if (name === "innerHtml") name = "innerHTML";
          }

          if (modifiers.camel && !isDynamic) {
            name = camelize(name);
          }

          // 如果存在.sync修饰符
          if (modifiers.sync) {
            syncGen = genAssignmentCode(value, `$event`);
            if (!isDynamic) {
              addHandler(
                el,
                `update:${camelize(name)}`,
                syncGen,
                null,
                false,
                warn,
                list[i]
              );
              if (hyphenate(name) !== camelize(name)) {
                addHandler(
                  el,
                  `update:${hyphenate(name)}`,
                  syncGen,
                  null,
                  false,
                  warn,
                  list[i]
                );
              }
            } else {
              // handler w/ dynamic event name
              addHandler(
                el,
                `"update:"+(${name})`,
                syncGen,
                null,
                false,
                warn,
                list[i],
                true // dynamic
              );
            }
          }
        }
        if (
          (modifiers && modifiers.prop) ||
          (!el.component && platformMustUseProp(el.tag, el.attrsMap.type, name))
        ) {
          addProp(el, name, value, list[i], isDynamic);
        } else {
          addAttr(el, name, value, list[i], isDynamic);
        }
      }
      // 如果绑定的是事件
      else if (onRE.test(name)) {
        // v-on
        name = name.replace(onRE, "");
        isDynamic = dynamicArgRE.test(name);
        if (isDynamic) {
          name = name.slice(1, -1);
        }
        addHandler(el, name, value, modifiers, false, warn, list[i], isDynamic);
      } else {
        // normal directives
        name = name.replace(dirRE, "");
        // parse arg
        const argMatch = name.match(argRE);
        let arg = argMatch && argMatch[1];
        isDynamic = false;
        if (arg) {
          name = name.slice(0, -(arg.length + 1));
          if (dynamicArgRE.test(arg)) {
            arg = arg.slice(1, -1);
            isDynamic = true;
          }
        }

        addDirective(
          el,
          name,
          rawName,
          value,
          arg,
          isDynamic,
          modifiers,
          list[i]
        );

        if (process.env.NODE_ENV !== "production" && name === "model") {
          checkForAliasModel(el, value);
        }
      }
    } else {
      // literal attribute
      if (process.env.NODE_ENV !== "production") {
        const res = parseText(value, delimiters);
        if (res) {
          warn(
            `${name}="${value}": ` +
              "Interpolation inside attributes has been removed. " +
              "Use v-bind or the colon shorthand instead. For example, " +
              'instead of <div id="{{ val }}">, use <div :id="val">.',
            list[i]
          );
        }
      }
      addAttr(el, name, JSON.stringify(value), list[i]);
      // #6887 firefox doesn't update muted state if set via attribute
      // even immediately after element creation
      if (
        !el.component &&
        name === "muted" &&
        platformMustUseProp(el.tag, el.attrsMap.type, name)
      ) {
        addProp(el, name, "true", list[i]);
      }
    }
  }
}

function checkInFor(el: ASTElement): boolean {
  let parent = el;
  while (parent) {
    if (parent.for !== undefined) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function parseModifiers(name: string): Object | void {
  const match = name.match(modifierRE);
  if (match) {
    const ret = {};
    match.forEach(m => {
      ret[m.slice(1)] = true;
    });
    return ret;
  }
}

function makeAttrsMap(attrs: Array<Object>): Object {
  const map = {};
  for (let i = 0, l = attrs.length; i < l; i++) {
    if (
      process.env.NODE_ENV !== "production" &&
      map[attrs[i].name] &&
      !isIE &&
      !isEdge
    ) {
      warn("duplicate attribute: " + attrs[i].name, attrs[i]);
    }
    map[attrs[i].name] = attrs[i].value;
  }
  return map;
}

// for script (e.g. type="x/template") or style, do not decode content
function isTextTag(el): boolean {
  return el.tag === "script" || el.tag === "style";
}

function isForbiddenTag(el): boolean {
  return (
    el.tag === "style" ||
    (el.tag === "script" &&
      (!el.attrsMap.type || el.attrsMap.type === "text/javascript"))
  );
}

const ieNSBug = /^xmlns:NS\d+/;
const ieNSPrefix = /^NS\d+:/;

/* istanbul ignore next */
function guardIESVGBug(attrs) {
  const res = [];
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (!ieNSBug.test(attr.name)) {
      attr.name = attr.name.replace(ieNSPrefix, "");
      res.push(attr);
    }
  }
  return res;
}

function checkForAliasModel(el, value) {
  let _el = el;
  while (_el) {
    if (_el.for && _el.alias === value) {
      warn(
        `<${el.tag} v-model="${value}">: ` +
          `You are binding v-model directly to a v-for iteration alias. ` +
          `This will not be able to modify the v-for source array because ` +
          `writing to the alias is like modifying a function local variable. ` +
          `Consider using an array of objects and use v-model on an object property instead.`,
        el.rawAttrsMap["v-model"]
      );
    }
    _el = _el.parent;
  }
}
